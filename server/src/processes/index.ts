import { EventEmitter } from 'node:events';
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
   * session attribution applies. */
  registerSelf(label: string | null) {
    this.rec.registerSelf(process.pid, label);
  }

  snapshot(): ProcessRow[] { return this.rec.getQualifyingRows(); }

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
    try {
      const [ps, cwds] = await Promise.all([this.listProcesses(), this.listCwds()]);
      const cwdLookup = (pid: number) => cwds.get(pid) ?? null;
      const { upserts, deletes } = this.rec.tick(ps, this.now(), cwdLookup);
      for (const r of upserts) this.emit('upsert', r);
      for (const id of deletes) this.emit('delete', id);
    } catch (e) {
      console.error('[processes] tick failed:', e);
    }
  }

  async maybeSweepPorts() {
    if (this.subscribers === 0) return;
    try {
      const portRows = await this.listPorts();
      // Direct-listener ports keyed by pid.
      const ownPorts = new Map<number, ProcessRow['ports']>();
      for (const r of portRows) ownPorts.set(r.pid, r.ports);

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
        const prev = row.ports;
        const same = prev.length === merged.length && prev.every((p, i) => {
          const m = merged[i];
          return m && m.proto === p.proto && m.addr === p.addr && m.port === p.port && !!m.inherited === !!p.inherited;
        });
        if (!same) {
          this.rec.setPorts(row.process_id, merged);
          this.emit('ports', { process_id: row.process_id, ports: merged });
        }
      }
    } catch (e) { console.error('[processes] port sweep failed:', e); }
  }

  async kill(processId: string): Promise<void> {
    const row = this.rec.getRow(processId);
    if (!row) throw new Error('process not tracked');
    await signalProcess(row.pid, 'TERM');
    setTimeout(() => { void signalProcess(row.pid, 'KILL').catch(() => {}); }, 3000);
    row.ended_reason = 'killed_by_user';
  }
}
