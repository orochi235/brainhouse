import type { PsRow } from './native.js';
import { detectRuntimeFromPath, detectRuntimeFromArgv } from './runtime.js';
import { detectFrameworkFromArgv, readPackageVersion } from './framework.js';

export type Provenance = 'hooked' | 'observed' | 'heuristic' | 'discovered';

export interface ProcessRow {
  process_id: string;
  host: 'local';
  pid: number; ppid: number; start_ts: number;
  command: string; cwd: string | null;
  session_id: string | null;
  hook_command: string | null;
  run_in_background: boolean;
  provenance: Provenance;
  runtime: string | null; runtime_version: string | null; runtime_source: string | null;
  framework: string | null; framework_version: string | null;
  /** Listening sockets the panel surfaces for this row. May include
   * both ports the process directly binds (no `inherited` flag) and
   * ports its tracked descendants bind (`inherited: true`). The UI
   * grays the inherited ones so it's clear which row "owns" the
   * binding. */
  ports: Array<{ proto: 'TCP'; addr: string; port: number; inherited?: boolean }>;
  ended_ts: number | null; ended_reason: string | null;
  uptime_s: number;
  /** Claude Code background bash id (`bash_1` style) when this row was
   * matched to a `run_in_background: true` Bash invocation via the
   * PostToolUse `bash_id_map` hook record. Lets the UI query
   * `processes.tailStdout` to fetch the latest captured stdout. */
  bash_id: string | null;
  /** Project path (a known Claude session's cwd) when we can pin the
   * process to a project but not to a single specific session. Set
   * either because multiple sessions share the cwd (ambiguous), or
   * because the process's cwd is inside a known project root but no
   * session is an exact match. The UI shows this as a project chip
   * in the Session column when session_id is null. */
  project: string | null;
  /** Account label this row should be attributed to. Set when the
   * spawning Claude session's hook carries a CLAUDE_CONFIG_DIR we can
   * resolve to a prefs root, or via brainhouse's own self-stamp for
   * its server + descendants. Survives session unregistration: a panel
   * teardown no longer erases the chip on the row. */
  account_label: string | null;
  /** Ancestor PIDs (immediate parent → root, exclusive of self) snapshotted
   * the first time we saw this row in ps. Used to retroactively attribute
   * a process to a Claude session that registers AFTER the process has
   * been reparented (e.g. brainhouse spawned via `npm run dev &` from a
   * Bash tool, then orphaned when the Bash subshell exits). The live ps
   * tree no longer reaches them from the session root; this remembered
   * chain still does. */
  original_ancestors: number[];
}

interface SessionInfo { pid: number; cwd: string; accountLabel?: string | null; }
interface BashIntent { command: string; run_in_background: boolean; cwd: string; ts: number; }

const SIGNAL_MIN_UPTIME_S = 3;
const INTENT_TTL_S = 30;
const INTENT_BUFFER_SIZE = 50;
const INTENT_MATCH_WINDOW_S = 2;

/** Discovered rows (no Claude session attribution) only qualify if they
 * bind a port — otherwise every long-running system process (launchd,
 * kernel_task, etc.) drowns the dashboard. Session-attributed rows keep
 * the wider signal-strong filter. Applied to BOTH the broadcast path
 * and the snapshot path so subscribers never see noise rows. */
export function qualifiesForBroadcast(row: ProcessRow): boolean {
  // Claude sessions themselves are always interesting, even when they
  // aren't tied to a brainhouse-known session_id (typical when brainhouse
  // started after the user's existing Claude sessions). The 'claude'
  // runtime label is set in runtime.ts → ARGV0_KNOWN.
  if (row.runtime === 'claude') return true;
  if (row.provenance === 'discovered') return row.ports.length > 0;
  return row.run_in_background || row.uptime_s >= SIGNAL_MIN_UPTIME_S || row.ports.length > 0;
}

export class Reconciler {
  private sessions = new Map<string, SessionInfo>();
  private intents = new Map<string, BashIntent[]>();
  private rows = new Map<string, ProcessRow>();
  private missingTicks = new Map<string, number>();
  private broadcasted = new Set<string>();
  private bashIdsBySession = new Map<string, string[]>();
  private transcriptPathBySession = new Map<string, string>();
  /** Brainhouse-internal "self" attribution. When set, the row for
   * `selfPid` and every row whose snapshotted ancestor chain contains
   * `selfPid` gets `account_label = selfAccountLabel` (unless already
   * attributed by a hook). Used to badge the brainhouse server and
   * its dev-mode children (vite, tsx watch, etc.) when no Claude
   * session spawned them. */
  private selfPid: number | null = null;
  private selfAccountLabel: string | null = null;

  registerSession(sessionId: string, info: SessionInfo) { this.sessions.set(sessionId, info); }

  /** Stamp brainhouse's own pid + descendants with a synthetic label.
   * Pass `null` for label to clear. */
  registerSelf(pid: number, label: string | null) {
    this.selfPid = pid;
    this.selfAccountLabel = label;
  }
  unregisterSession(sessionId: string) {
    this.sessions.delete(sessionId);
    this.intents.delete(sessionId);
    this.bashIdsBySession.delete(sessionId);
    this.transcriptPathBySession.delete(sessionId);
  }
  recordBashId(sessionId: string, bashId: string) {
    const arr = this.bashIdsBySession.get(sessionId) ?? [];
    arr.push(bashId);
    while (arr.length > 20) arr.shift();
    this.bashIdsBySession.set(sessionId, arr);
  }
  setTranscriptPath(sessionId: string, transcriptPath: string) {
    this.transcriptPathBySession.set(sessionId, transcriptPath);
  }
  getTranscriptPath(sessionId: string): string | undefined {
    return this.transcriptPathBySession.get(sessionId);
  }
  recordBashIntent(sessionId: string, intent: BashIntent) {
    const arr = this.intents.get(sessionId) ?? [];
    arr.push(intent);
    while (arr.length > INTENT_BUFFER_SIZE) arr.shift();
    this.intents.set(sessionId, arr);
  }

  tick(
    ps: PsRow[],
    nowS: number,
    cwdLookup?: (pid: number) => string | null,
  ): { upserts: ProcessRow[]; deletes: string[] } {
    const sessionOf = new Map<number, string>();
    for (const [sid, info] of this.sessions) {
      // Attribute the session's root PID itself so the Claude process
      // shows up in the panel alongside its descendants. Without this,
      // the user can't see "the process this session is running."
      sessionOf.set(info.pid, sid);
      const stack = [info.pid];
      const seen = new Set<number>([info.pid]);
      while (stack.length) {
        const parent = stack.pop()!;
        for (const p of ps) {
          if (p.ppid === parent && !seen.has(p.pid)) {
            seen.add(p.pid);
            sessionOf.set(p.pid, sid);
            stack.push(p.pid);
          }
        }
      }
    }

    // Live ppid lookup for ancestor-chain snapshotting at row creation.
    const ppidByPid = new Map<number, number>();
    for (const p of ps) ppidByPid.set(p.pid, p.ppid);

    // Quick lookup: PID → session_id for any registered session root.
    // Used both by sessionOf BFS (above) and by row-creation/retroactive
    // attribution (below).
    const sessionRootByPid = new Map<number, string>();
    for (const [sid, info] of this.sessions) sessionRootByPid.set(info.pid, sid);

    const presentIds = new Set<string>();
    const upserts: ProcessRow[] = [];

    for (const p of ps) {
      const processId = `p_local_${p.pid}_${p.start_ts}`;
      presentIds.add(processId);

      let row = this.rows.get(processId);
      if (!row) {
        // PID recycling: same pid, different start_ts → drop old row
        for (const [oldId, oldRow] of this.rows) {
          if (oldRow.pid === p.pid && oldRow.start_ts !== p.start_ts) {
            this.rows.delete(oldId);
            this.missingTicks.delete(oldId);
          }
        }
        // Snapshot the ancestor chain at first observation. After this
        // row exists, reparenting events (PPID → 1) can't erase the
        // historical lineage.
        const ancestors: number[] = [];
        const seenAnc = new Set<number>();
        let cur = p.ppid;
        while (cur > 1 && !seenAnc.has(cur)) {
          ancestors.push(cur);
          seenAnc.add(cur);
          const next = ppidByPid.get(cur);
          if (next === undefined) break;
          cur = next;
        }
        row = this.createRow(processId, p, sessionOf.get(p.pid) ?? null, cwdLookup?.(p.pid) ?? null, ancestors);
        this.rows.set(processId, row);
      }

      const sid = sessionOf.get(p.pid) ?? row.session_id;
      if (sid && !row.session_id) {
        row.session_id = sid;
        if (row.provenance === 'discovered') row.provenance = 'observed';
      }
      // Retroactive attribution via the snapshotted ancestor chain.
      // Survives reparenting: if any captured ancestor is now a
      // registered session root, attribute to that session.
      if (!row.session_id) {
        for (const ancPid of row.original_ancestors) {
          const ancSid = sessionRootByPid.get(ancPid);
          if (ancSid) {
            row.session_id = ancSid;
            if (row.provenance === 'discovered') row.provenance = 'observed';
            break;
          }
        }
      }
      // Account inheritance from the attributed session, when the
      // session was registered with a label (hook carried CLAUDE_CONFIG_DIR
      // that resolved to a prefs root). Sticky — once stamped we don't
      // clobber it, so the chip survives the session unregistering.
      if (row.session_id && !row.account_label) {
        const info = this.sessions.get(row.session_id);
        if (info?.accountLabel) row.account_label = info.accountLabel;
      }
      // Whenever we have a session_id, also surface its cwd as the
      // project so the panel's Project column has something to show
      // for every attributed row (not just rows attributed via the
      // cwd-heuristic tier).
      if (row.session_id && !row.project) {
        const info = this.sessions.get(row.session_id);
        if (info?.cwd) row.project = info.cwd;
      }
      // cwd-based attribution if not in tree. We treat exact and
      // descendant matches the same way: a session's cwd is either
      // identical to the process's cwd, or an ancestor of it. The
      // attribution outcome depends on how many sessions qualify.
      //   - One session qualifies → attribute to that session
      //     (heuristic). Also set project so the UI can still surface
      //     the project context if needed.
      //   - Multiple qualify → can't pin a session; attribute to the
      //     deepest shared project root.
      if (!row.session_id && !row.project && cwdLookup) {
        const cwd = cwdLookup(p.pid);
        if (cwd) {
          const matches: Array<{ sid: string; cwd: string }> = [];
          for (const [sid, info] of this.sessions) {
            if (!info.cwd) continue;
            if (info.cwd === cwd || cwd.startsWith(`${info.cwd}/`)) {
              matches.push({ sid, cwd: info.cwd });
            }
          }
          if (matches.length === 1) {
            const only = matches[0]!;
            row.session_id = only.sid;
            row.project = only.cwd;
            if (row.provenance === 'discovered') row.provenance = 'heuristic';
          } else if (matches.length > 1) {
            // Multiple sessions are candidates. Use the deepest cwd as
            // the project root (most specific). Don't set session_id —
            // we genuinely can't tell which session it belongs to.
            const deepest = matches.sort((a, b) => b.cwd.length - a.cwd.length)[0]!;
            row.project = deepest.cwd;
            if (row.provenance === 'discovered') row.provenance = 'heuristic';
          }
        }
      }

      // Intent matching (only if not already hooked)
      if (row.session_id && row.provenance === 'observed') {
        const intents = this.intents.get(row.session_id) ?? [];
        const procStartS = p.start_ts / 1_000_000_000;
        const match = intents.find(i => Math.abs(i.ts - procStartS) <= INTENT_MATCH_WINDOW_S);
        if (match) {
          row.provenance = 'hooked';
          row.hook_command = match.command;
          row.run_in_background = match.run_in_background;
          if (match.run_in_background && row.bash_id === null) {
            const arr = this.bashIdsBySession.get(row.session_id) ?? [];
            const id = arr.shift();
            if (id) row.bash_id = id;
            this.bashIdsBySession.set(row.session_id, arr);
          }
        }
      }

      // Self-stamp: brainhouse's own process and anything spawned by
      // it inherit the synthetic label. Runs after hook/session
      // attribution so a real account always wins.
      if (!row.account_label && this.selfPid !== null && this.selfAccountLabel) {
        if (row.pid === this.selfPid || row.original_ancestors.includes(this.selfPid)) {
          row.account_label = this.selfAccountLabel;
        }
      }

      row.uptime_s = nowS - p.start_ts / 1_000_000_000;
      this.missingTicks.delete(processId);

      if (qualifiesForBroadcast(row)) {
        upserts.push(row);
        this.broadcasted.add(processId);
      }
    }

    const deletes: string[] = [];
    for (const [id, row] of this.rows) {
      if (presentIds.has(id)) continue;
      const n = (this.missingTicks.get(id) ?? 0) + 1;
      if (n >= 2) {
        row.ended_ts = nowS;
        row.ended_reason = row.ended_reason ?? 'lost';
        if (this.broadcasted.has(id)) deletes.push(id);
        this.rows.delete(id);
        this.missingTicks.delete(id);
        this.broadcasted.delete(id);
      } else {
        this.missingTicks.set(id, n);
      }
    }

    // Prune stale intents
    for (const [sid, arr] of this.intents) {
      this.intents.set(sid, arr.filter(i => nowS - i.ts < INTENT_TTL_S));
    }

    return { upserts, deletes };
  }

  setPorts(processId: string, ports: ProcessRow['ports']) {
    const row = this.rows.get(processId);
    if (row) row.ports = ports;
  }

  getRow(processId: string): ProcessRow | undefined { return this.rows.get(processId); }
  getRows(): ProcessRow[] { return Array.from(this.rows.values()); }
  /** Rows that would currently broadcast — for snapshot delivery. */
  getQualifyingRows(): ProcessRow[] {
    return Array.from(this.rows.values()).filter(qualifiesForBroadcast);
  }
  rowByPid(pid: number): ProcessRow | undefined {
    for (const r of this.rows.values()) if (r.pid === pid) return r;
    return undefined;
  }

  private createRow(
    id: string,
    p: PsRow,
    sessionId: string | null,
    cwd: string | null,
    originalAncestors: number[],
  ): ProcessRow {
    const argv = p.command.split(/\s+/);
    const rtPath = detectRuntimeFromPath(argv[0] ?? '');
    const rtArgv = rtPath ? null : detectRuntimeFromArgv(argv);
    const rt = rtPath ?? rtArgv;
    const fw = detectFrameworkFromArgv(argv);
    return {
      process_id: id, host: 'local',
      pid: p.pid, ppid: p.ppid, start_ts: p.start_ts,
      command: p.command, cwd,
      session_id: sessionId,
      hook_command: null, run_in_background: false,
      provenance: sessionId ? 'observed' : 'discovered',
      runtime: rt?.runtime ?? null, runtime_version: rt?.runtime_version ?? null, runtime_source: rt?.runtime_source ?? null,
      framework: fw?.framework ?? null,
      framework_version: fw?.package_path ? readPackageVersion(fw.package_path) : null,
      ports: [],
      ended_ts: null, ended_reason: null,
      uptime_s: 0,
      bash_id: null,
      project: null,
      account_label: null,
      original_ancestors: originalAncestors,
    };
  }
}
