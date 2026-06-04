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
  ports: Array<{ proto: 'TCP'; addr: string; port: number }>;
  ended_ts: number | null; ended_reason: string | null;
  uptime_s: number;
  /** Claude Code background bash id (`bash_1` style) when this row was
   * matched to a `run_in_background: true` Bash invocation via the
   * PostToolUse `bash_id_map` hook record. Lets the UI query
   * `processes.tailStdout` to fetch the latest captured stdout. */
  bash_id: string | null;
}

interface SessionInfo { pid: number; cwd: string; }
interface BashIntent { command: string; run_in_background: boolean; cwd: string; ts: number; }

const SIGNAL_MIN_UPTIME_S = 3;
const INTENT_TTL_S = 30;
const INTENT_BUFFER_SIZE = 50;
const INTENT_MATCH_WINDOW_S = 2;

export class Reconciler {
  private sessions = new Map<string, SessionInfo>();
  private intents = new Map<string, BashIntent[]>();
  private rows = new Map<string, ProcessRow>();
  private missingTicks = new Map<string, number>();
  private broadcasted = new Set<string>();
  private bashIdsBySession = new Map<string, string[]>();
  private transcriptPathBySession = new Map<string, string>();

  registerSession(sessionId: string, info: SessionInfo) { this.sessions.set(sessionId, info); }
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
        row = this.createRow(processId, p, sessionOf.get(p.pid) ?? null, cwdLookup?.(p.pid) ?? null);
        this.rows.set(processId, row);
      }

      const sid = sessionOf.get(p.pid) ?? row.session_id;
      if (sid && !row.session_id) row.session_id = sid;
      // Heuristic cwd attribution if not in tree
      if (!row.session_id && cwdLookup) {
        const cwd = cwdLookup(p.pid);
        if (cwd) {
          for (const [s, info] of this.sessions) {
            if (info.cwd === cwd) { row.session_id = s; row.provenance = 'heuristic'; break; }
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

      row.uptime_s = nowS - p.start_ts / 1_000_000_000;
      this.missingTicks.delete(processId);

      const qualifies = row.run_in_background || row.uptime_s >= SIGNAL_MIN_UPTIME_S || row.ports.length > 0;
      if (qualifies) {
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
  rowByPid(pid: number): ProcessRow | undefined {
    for (const r of this.rows.values()) if (r.pid === pid) return r;
    return undefined;
  }

  private createRow(id: string, p: PsRow, sessionId: string | null, cwd: string | null): ProcessRow {
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
    };
  }
}
