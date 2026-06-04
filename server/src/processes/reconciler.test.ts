import { describe, it, expect } from 'vitest';
import { Reconciler } from './reconciler.js';
import type { PsRow } from './native.js';

const baseProc = (over: Partial<PsRow>): PsRow => ({
  pid: 100, ppid: 1, start_ts: 1000, comm: 'node', command: 'node x', ...over,
});

describe('Reconciler', () => {
  it('attributes a new descendant to its session', () => {
    const r = new Reconciler();
    r.registerSession('s1', { pid: 50, cwd: '/p' });
    const { upserts } = r.tick([
      baseProc({ pid: 50, ppid: 1, command: 'claude' }),
      baseProc({ pid: 100, ppid: 50, command: 'node /p/node_modules/vite/bin/vite.js' }),
    ], 5000);
    const vite = upserts.find(u => u.pid === 100);
    expect(vite).toBeDefined();
    expect(vite!.session_id).toBe('s1');
    expect(vite!.provenance).toBe('observed');
    expect(vite!.framework).toBe('vite');
  });

  it('promotes provenance to hooked when bash_intent matches', () => {
    const r = new Reconciler();
    r.registerSession('s1', { pid: 50, cwd: '/p' });
    r.recordBashIntent('s1', { command: 'npm run dev', run_in_background: true, cwd: '/p', ts: 4.9 });
    const { upserts } = r.tick([
      baseProc({ pid: 50, ppid: 1, command: 'claude' }),
      baseProc({ pid: 100, ppid: 50, start_ts: 5_000_000_000, command: 'node vite' }),
    ], 5);
    const row = upserts.find(u => u.pid === 100)!;
    expect(row.provenance).toBe('hooked');
    expect(row.hook_command).toBe('npm run dev');
    expect(row.run_in_background).toBe(true);
  });

  it('attaches bash_id to backgrounded run_in_background row', () => {
    const r = new Reconciler();
    r.registerSession('s1', { pid: 50, cwd: '/p' });
    r.recordBashIntent('s1', { command: 'npm run dev', run_in_background: true, cwd: '/p', ts: 4.9 });
    r.recordBashId('s1', 'bg_1');
    const { upserts } = r.tick([
      baseProc({ pid: 50, ppid: 1, command: 'claude' }),
      baseProc({ pid: 100, ppid: 50, start_ts: 5_000_000_000, command: 'node vite' }),
    ], 5);
    expect(upserts.find(u => u.pid === 100)?.bash_id).toBe('bg_1');
  });

  it('does not emit deltas for sub-3s commands with no port and no run_in_background', () => {
    const r = new Reconciler();
    r.registerSession('s1', { pid: 50, cwd: '/p' });
    const { upserts } = r.tick([
      baseProc({ pid: 50, ppid: 1 }),
      baseProc({ pid: 100, ppid: 50, comm: 'grep', command: 'grep foo' }),
    ], 1);
    expect(upserts.find(u => u.pid === 100)).toBeUndefined();
  });

  it('two-tick absence rule', () => {
    const r = new Reconciler();
    r.registerSession('s1', { pid: 50, cwd: '/p' });
    r.tick([
      baseProc({ pid: 50 }),
      baseProc({ pid: 100, ppid: 50, command: 'node x', start_ts: 0 }),
    ], 4); // qualifies (uptime 4s)
    // First missing tick: no delete yet
    let result = r.tick([baseProc({ pid: 50 })], 6);
    expect(result.deletes).toHaveLength(0);
    // Second missing tick: delete
    result = r.tick([baseProc({ pid: 50 })], 8);
    expect(result.deletes).toHaveLength(1);
  });

  it('heuristic attribution by cwd when not in tree', () => {
    const r = new Reconciler();
    r.registerSession('s1', { pid: 50, cwd: '/p' });
    const { upserts } = r.tick([
      baseProc({ pid: 50, ppid: 1 }),
      baseProc({ pid: 200, ppid: 1, command: 'node x', start_ts: 0 }),
    ], 5, /* cwdLookup */ (pid) => pid === 200 ? '/p' : null);
    const row = upserts.find(u => u.pid === 200);
    expect(row?.provenance).toBe('heuristic');
    expect(row?.session_id).toBe('s1');
  });

  it('PID recycling: same pid, different start_ts → new row', () => {
    const r = new Reconciler();
    r.registerSession('s1', { pid: 50, cwd: '/p' });
    r.tick([baseProc({ pid: 50 }), baseProc({ pid: 100, ppid: 50, start_ts: 1, command: 'node a' })], 5);
    r.tick([baseProc({ pid: 50 }), baseProc({ pid: 100, ppid: 50, start_ts: 1, command: 'node a' })], 6);
    const result = r.tick([baseProc({ pid: 50 }), baseProc({ pid: 100, ppid: 50, start_ts: 999, command: 'node b' })], 7);
    expect(result.deletes.length + result.upserts.length).toBeGreaterThanOrEqual(2);
    const newRow = result.upserts.find(u => u.command === 'node b');
    expect(newRow).toBeDefined();
    expect(newRow!.process_id).not.toBe('p_local_100_1');
  });
});
