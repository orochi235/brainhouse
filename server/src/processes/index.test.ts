import { describe, it, expect, vi } from 'vitest';
import { ProcessTracker } from './index.js';

describe('ProcessTracker', () => {
  it('emits process_upsert when a qualifying process appears', async () => {
    const psFake = vi.fn().mockResolvedValueOnce([
      { pid: 50, ppid: 1, start_ts: 0, comm: 'node', command: 'claude' },
      { pid: 100, ppid: 50, start_ts: 0, comm: 'node', command: 'node /p/node_modules/vite/bin/vite.js' },
    ]);
    const t = new ProcessTracker({
      listProcesses: psFake,
      listListeningPorts: async () => [],
      now: () => 10,
    });
    const events: any[] = [];
    t.on('upsert', r => events.push({ kind: 'upsert', r }));
    t.on('delete', id => events.push({ kind: 'delete', id }));
    t.handleHookRecord({ kind: 'session_pid', session_id: 's1', pid: 50, ppid: 1, cwd: '/p', start_ts: 0, ts: 0 } as any);
    await t.tickOnce();
    expect(events.some(e => e.kind === 'upsert' && e.r.framework === 'vite')).toBe(true);
  });

  it('port sweeper idles when no subscribers', async () => {
    const lsof = vi.fn().mockResolvedValue([]);
    const t = new ProcessTracker({
      listProcesses: async () => [],
      listListeningPorts: lsof,
      now: () => 0,
    });
    await t.maybeSweepPorts();
    expect(lsof).not.toHaveBeenCalled();
    t.addSubscriber();
    await t.maybeSweepPorts();
    expect(lsof).toHaveBeenCalledOnce();
  });
});
