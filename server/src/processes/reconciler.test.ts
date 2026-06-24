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

  it('project chip uses the session repo root, not its working subdir', () => {
    const r = new Reconciler();
    r.registerSession('s1', { pid: 50, cwd: '/repo/client', repoRoot: '/repo' });
    const { upserts } = r.tick([
      baseProc({ pid: 50, ppid: 1, command: 'claude' }),
      baseProc({ pid: 100, ppid: 50, command: 'node /repo/client/node_modules/vite/bin/vite.js' }),
    ], 5);
    // The Project chip identifies the repo, not whichever subdir the session
    // happened to run from — so it stays stable and matches the project widget.
    expect(upserts.find(u => u.pid === 100)?.project).toBe('/repo');
  });

  it('multi-session cwd match resolves project to the repo root, not the deepest cwd', () => {
    const r = new Reconciler();
    // Two sessions in the same repo, one in a subdir. A non-tree process deep
    // inside the repo matches both; the deepest session is /repo/client, but the
    // project identity must remain the repo so adding the subdir session can't
    // shift an existing row's tag color.
    r.registerSession('s1', { pid: 50, cwd: '/repo', repoRoot: '/repo' });
    r.registerSession('s2', { pid: 60, cwd: '/repo/client', repoRoot: '/repo' });
    const { upserts } = r.tick([
      baseProc({ pid: 50, ppid: 1 }),
      baseProc({ pid: 60, ppid: 1 }),
      baseProc({ pid: 200, ppid: 1, command: 'node x', start_ts: 0 }),
    ], 5, (pid) => pid === 200 ? '/repo/client/sub' : null);
    expect(upserts.find(u => u.pid === 200)?.project).toBe('/repo');
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
    // New row appears with the new process_id (start_ts disambiguates).
    const newRow = result.upserts.find(u => u.command === 'node b');
    expect(newRow).toBeDefined();
    expect(newRow!.process_id).toBe('p_local_100_999');
    // Old row is dropped from the table outright (not a 2-tick absence).
    expect(r.getRow('p_local_100_1')).toBeUndefined();
  });

  it('retroactive attribution: orphaned descendant stays linked after reparenting', () => {
    const r = new Reconciler();
    r.registerSession('s1', { pid: 50, cwd: '/p' });
    // First tick: full tree. claude (50) → bash (60) → npm (100).
    r.tick([
      baseProc({ pid: 50, ppid: 1, command: 'claude' }),
      baseProc({ pid: 60, ppid: 50, command: 'bash' }),
      baseProc({ pid: 100, ppid: 60, command: 'node dev-server' }),
    ], 5);
    // Confirm initial attribution worked.
    expect(r.getQualifyingRows().find(u => u.pid === 100)?.session_id).toBe('s1');
    // Second tick: bash (60) has exited, npm (100) reparented to launchd (ppid=1).
    // The live BFS from session root 50 no longer reaches pid 100.
    const result = r.tick([
      baseProc({ pid: 50, ppid: 1, command: 'claude' }),
      baseProc({ pid: 100, ppid: 1, command: 'node dev-server' }),
    ], 10);
    const stillLinked = result.upserts.find(u => u.pid === 100);
    expect(stillLinked).toBeDefined();
    expect(stillLinked!.session_id).toBe('s1');
  });

  it('retroactive attribution: row created before session registers gets attributed later', () => {
    const r = new Reconciler();
    // Tick 1: process tree exists but no sessions registered yet.
    r.tick([
      baseProc({ pid: 50, ppid: 1, command: 'claude' }),
      baseProc({ pid: 60, ppid: 50, command: 'bash' }),
      baseProc({ pid: 100, ppid: 60, command: 'node x' }),
    ], 5);
    const orphan = r.getRow('p_local_100_1000');
    expect(orphan?.session_id).toBeNull();
    // Session registers AFTER the row exists.
    r.registerSession('s1', { pid: 50, cwd: '/p' });
    // Tick 2: bash already exited, pid 100 reparented. But ancestor chain
    // remembered from tick 1 still includes pid 50, so attribution lands.
    r.tick([
      baseProc({ pid: 50, ppid: 1, command: 'claude' }),
      baseProc({ pid: 100, ppid: 1, command: 'node x' }),
    ], 8);
    expect(r.getRow('p_local_100_1000')?.session_id).toBe('s1');
    expect(r.getRow('p_local_100_1000')?.provenance).toBe('observed');
  });
});
