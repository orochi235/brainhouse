import { EventEmitter } from 'node:events';
import { HttpProbe } from './httpProbe.js';
import { Reconciler, type ProcessRow } from './reconciler.js';
import {
  listCwds as realListCwds,
  listListeningPorts as realListPorts,
  listProcesses as realListProcesses,
  signalProcess,
} from './native.js';

export type { ProcessRow } from './reconciler.js';

export type TrackerDeps = {
  listProcesses?: typeof realListProcesses;
  listListeningPorts?: typeof realListPorts;
  listCwds?: typeof realListCwds;
  now?: () => number;
};

export class ProcessTracker extends EventEmitter {
  private rec = new Reconciler();
  private subscribers = 0;
  private listProcesses: typeof realListProcesses;
  private listPorts: typeof realListPorts;
  private listCwds: typeof realListCwds;
  private now: () => number;
  private tickTimer?: NodeJS.Timeout;
  private portTimer?: NodeJS.Timeout;
  private httpProbe = new HttpProbe();
  // Reentrancy guards: `ps`/`lsof` over a full process table can take longer
  // than the tick/sweep interval. Without these, a slow run lets the next
  // interval fire while the prior is still in flight, stacking concurrent
  // child_process spawns — which is exactly what triggers the intermittent
  // libuv `spawn EBADF` fd race. A skipped tick is harmless: the next
  // interval samples fresh state anyway.
  private ticking = false;
  private sweeping = false;

  constructor(deps: TrackerDeps = {}) {
    super();
    this.listProcesses = deps.listProcesses ?? realListProcesses;
    this.listPorts = deps.listListeningPorts ?? realListPorts;
    this.listCwds = deps.listCwds ?? realListCwds;
    this.now = deps.now ?? (() => Date.now() / 1000);
  }

  start() {
    this.tickTimer = setInterval(() => { void this.tickOnce(); }, 1000);
    this.portTimer = setInterval(() => { void this.maybeSweepPorts(); }, 5000);
  }
  stop() {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.portTimer) clearInterval(this.portTimer);
  }

  addSubscriber() { this.subscribers++; }
  removeSubscriber() { this.subscribers = Math.max(0, this.subscribers - 1); }

  /** Stamp the brainhouse server's own pid (and its descendants) with
   * a synthetic account label. Lets dev-mode self-spawned processes
   * (vite, tsx watch) show an account chip even though no Claude
   * session attribution applies. The framework + version (when
   * supplied) are stamped only on the self pid so brainhouse appears
   * as a recognized service in the Network view's Framework column. */
  registerSelf(label: string | null, framework: string | null = null, version: string | null = null) {
    this.rec.registerSelf(process.pid, label, framework, version);
  }

  snapshot(): ProcessRow[] { return this.rec.getQualifyingRows(); }

  /** Session ids that currently have at least one live (qualifying) process
   * attributed to them — i.e. their `claude` process is still running. The
   * SessionStore uses this to avoid flipping a still-working session to
   * `done` during a long transcript-quiet stretch. A session drops out
   * within ~2 sweeps of its process exiting (the reconciler's miss debounce). */
  liveSessionIds(): Set<string> {
    const ids = new Set<string>();
    for (const r of this.rec.getQualifyingRows()) if (r.session_id) ids.add(r.session_id);
    return ids;
  }

  handleHookRecord(rec: any) {
    if (rec.kind === 'session_pid') {
      this.rec.registerSession(rec.session_id, {
        pid: rec.pid,
        cwd: rec.cwd ?? '',
        accountLabel: typeof rec.account_label === 'string' ? rec.account_label : null,
      });
    } else if (rec.kind === 'bash_intent') {
      this.rec.recordBashIntent(rec.session_id, {
        command: rec.command ?? '', run_in_background: rec.run_in_background ?? false,
        cwd: rec.cwd ?? '', ts: rec.ts,
      });
    } else if (rec.kind === 'bash_id_map') {
      this.rec.recordBashId(rec.session_id, rec.bash_id);
      if (typeof rec.transcript_path === 'string') {
        this.rec.setTranscriptPath(rec.session_id, rec.transcript_path);
      }
    } else if (rec.kind === 'session_end') {
      // `stop` is a per-turn idle marker, NOT a session terminator —
      // it fires after every assistant message. Only `session_end`
      // means the Claude session has actually exited; unregistering
      // on `stop` would drop attribution on every turn.
      this.rec.unregisterSession(rec.session_id);
    }
    // Opportunistically capture transcript_path on any hook with it.
    if (typeof rec.transcript_path === 'string' && typeof rec.session_id === 'string') {
      this.rec.setTranscriptPath(rec.session_id, rec.transcript_path);
    }
  }

  getTranscriptPath(sessionId: string): string | undefined {
    return this.rec.getTranscriptPath(sessionId);
  }

  async tickOnce() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const [ps, cwds] = await Promise.all([this.listProcesses(), this.listCwds()]);
      const cwdLookup = (pid: number) => cwds.get(pid) ?? null;
      const { upserts, deletes } = this.rec.tick(ps, this.now(), cwdLookup);
      for (const r of upserts) this.emit('upsert', r);
      for (const id of deletes) this.emit('delete', id);
    } catch (e) {
      console.error('[processes] tick failed:', e);
    } finally {
      this.ticking = false;
    }
  }

  async maybeSweepPorts() {
    if (this.subscribers === 0) return;
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const portRows = await this.listPorts();
      // A null result means the lsof call failed (timeout / fork-exec
      // storm), NOT that every listener vanished. Bail without touching
      // the cache — otherwise we'd re-broadcast `ports: []` for every
      // row and the Network view oscillates between its real port-binders
      // and zero on each bad sample. (Same stickiness rationale as the
      // is_http cache below.)
      if (portRows === null) return;
      // Direct-listener ports keyed by pid. Each port also carries the
      // latest cached `is_http` result (null when never probed); the
      // probe itself runs out-of-band below.
      const ownPorts = new Map<number, ProcessRow['ports']>();
      const unprobed = new Set<number>();
      const listening = new Set<number>();
      for (const r of portRows) {
        const stamped = r.ports.map((p) => {
          listening.add(p.port);
          const known = this.httpProbe.get(p.port);
          if (known === null) unprobed.add(p.port);
          return { ...p, is_http: known };
        });
        ownPorts.set(r.pid, stamped);
      }
      // Evict is_http cache entries for ports no longer listening. This
      // is safe *only* because the `portRows === null` bail above means
      // we never reach here on an lsof failure/timeout — a transient
      // empty result (the flicker risk) surfaces as null, not as an
      // empty array. A genuinely-empty array means nothing is listening,
      // so dropping every cached entry is correct: a dead → reused port
      // then gets re-probed instead of inheriting the prior binder's
      // result.
      this.httpProbe.retainOnly(listening);

      // Reverse-ancestor lookup: for each tracked row R, find all
      // tracked rows D where R.pid ∈ D.original_ancestors. Anyone in
      // that descendant set with a port "lends" it upward, so a wrapper
      // process (run-p, tsx watch, npm) reads as serving whatever its
      // child process is bound to. Falls back to row.ports = [] when no
      // listener is anywhere in the subtree.
      const allTracked = this.rec.getRows();
      const descendantsOf = new Map<number, ProcessRow[]>();
      for (const r of allTracked) {
        for (const ancPid of r.original_ancestors) {
          const list = descendantsOf.get(ancPid);
          if (list) list.push(r);
          else descendantsOf.set(ancPid, [r]);
        }
      }

      for (const row of allTracked) {
        const own = ownPorts.get(row.pid) ?? [];
        const inherited: ProcessRow['ports'] = [];
        for (const desc of descendantsOf.get(row.pid) ?? []) {
          const dp = ownPorts.get(desc.pid);
          if (dp) {
            for (const p of dp) inherited.push({ ...p, inherited: true });
          }
        }
        // De-dupe — own wins, since a process that both binds a port
        // AND has a descendant binding the same one isn't really
        // "inheriting" it.
        const seen = new Set<string>();
        const merged: ProcessRow['ports'] = [];
        for (const p of own) {
          const k = `${p.proto}|${p.addr}|${p.port}`;
          if (!seen.has(k)) { seen.add(k); merged.push(p); }
        }
        for (const p of inherited) {
          const k = `${p.proto}|${p.addr}|${p.port}`;
          if (!seen.has(k)) { seen.add(k); merged.push(p); }
        }
        // Only re-broadcast when something actually changed for the row.
        // is_http counts as a change so the link affordance can flip
        // when a probe lands.
        const prev = row.ports;
        const same = prev.length === merged.length && prev.every((p, i) => {
          const m = merged[i];
          return (
            !!m &&
            m.proto === p.proto &&
            m.addr === p.addr &&
            m.port === p.port &&
            !!m.inherited === !!p.inherited &&
            (m.is_http ?? null) === (p.is_http ?? null)
          );
        });
        if (!same) {
          this.rec.setPorts(row.process_id, merged);
          this.emit('ports', { process_id: row.process_id, ports: merged });
        }
      }
      // Kick off probes for newly-seen ports. Only POSITIVE results
      // trigger a re-sweep (so the link can show up immediately);
      // negative results just stay null and wait for the next regular
      // tick. Without this guard, non-HTTP ports trigger a sweep on
      // every probe completion, which re-discovers them as unprobed
      // (negatives aren't cached) and fires them again — an infinite
      // probe loop that pegs the event loop.
      for (const port of unprobed) {
        void this.httpProbe.probe(port).then((ok) => {
          if (ok && this.subscribers > 0) void this.maybeSweepPorts();
        });
      }
    } catch (e) { console.error('[processes] port sweep failed:', e); }
    finally { this.sweeping = false; }
  }

  async kill(processId: string): Promise<void> {
    const row = this.rec.getRow(processId);
    if (!row) throw new Error('process not tracked');
    await signalProcess(row.pid, 'TERM');
    setTimeout(() => { void signalProcess(row.pid, 'KILL').catch(() => {}); }, 3000);
    row.ended_reason = 'killed_by_user';
  }
}
