import { EventEmitter } from 'node:events';
import { Reconciler, type ProcessRow } from './reconciler.js';
import { listProcesses as realListProcesses, listListeningPorts as realListPorts, signalProcess } from './native.js';

export type { ProcessRow } from './reconciler.js';

export type TrackerDeps = {
  listProcesses?: typeof realListProcesses;
  listListeningPorts?: typeof realListPorts;
  now?: () => number;
};

export class ProcessTracker extends EventEmitter {
  private rec = new Reconciler();
  private subscribers = 0;
  private listProcesses: typeof realListProcesses;
  private listPorts: typeof realListPorts;
  private now: () => number;
  private tickTimer?: NodeJS.Timeout;
  private portTimer?: NodeJS.Timeout;

  constructor(deps: TrackerDeps = {}) {
    super();
    this.listProcesses = deps.listProcesses ?? realListProcesses;
    this.listPorts = deps.listListeningPorts ?? realListPorts;
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

  snapshot(): ProcessRow[] { return this.rec.getRows(); }

  handleHookRecord(rec: any) {
    if (rec.kind === 'session_pid') {
      this.rec.registerSession(rec.session_id, { pid: rec.pid, cwd: rec.cwd ?? '' });
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
    } else if (rec.kind === 'session_end' || rec.kind === 'stop') {
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
      const ps = await this.listProcesses();
      const { upserts, deletes } = this.rec.tick(ps, this.now());
      for (const r of upserts) this.emit('upsert', r);
      for (const id of deletes) this.emit('delete', id);
    } catch (e) {
      console.error('[processes] tick failed:', e);
    }
  }

  async maybeSweepPorts() {
    if (this.subscribers === 0) return;
    try {
      const rows = await this.listPorts();
      for (const row of rows) {
        const procRow = this.rec.rowByPid(row.pid);
        if (procRow) {
          this.rec.setPorts(procRow.process_id, row.ports);
          this.emit('ports', { process_id: procRow.process_id, ports: row.ports });
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
