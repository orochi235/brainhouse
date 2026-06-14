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

  it('keeps known ports when an lsof sweep transiently fails', async () => {
    // A successful sweep observes vite bound to :5173. A subsequent
    // sweep where lsof times out / errors (modeled as null, the failure
    // signal) must NOT be treated as "the port is gone" — otherwise the
    // row flickers out of the Network view and back on the next good
    // sample (the 0 ↔ same-5 oscillation).
    let lsofResult: any = [
      { pid: 100, ports: [{ proto: 'TCP', addr: '127.0.0.1', port: 5173 }] },
    ];
    const t = new ProcessTracker({
      listProcesses: async () => [
        { pid: 50, ppid: 1, start_ts: 0, comm: 'claude', command: 'claude' },
        { pid: 100, ppid: 50, start_ts: 0, comm: 'node', command: 'node /p/node_modules/vite/bin/vite.js' },
      ],
      listListeningPorts: async () => lsofResult,
      listCwds: async () => new Map(),
      now: () => 10,
    });
    t.addSubscriber();
    t.handleHookRecord({ kind: 'session_pid', session_id: 's1', pid: 50, ppid: 1, cwd: '/p', start_ts: 0, ts: 0 } as any);
    await t.tickOnce();
    await t.maybeSweepPorts(); // good sample → row owns :5173

    const portEvents: any[] = [];
    t.on('ports', (e: any) => portEvents.push(e));
    lsofResult = null; // simulate lsof timeout / spawn failure
    await t.maybeSweepPorts();

    const row = t.snapshot().find(r => r.pid === 100);
    expect(row?.ports.map(p => p.port)).toContain(5173);
    expect(portEvents.some(e => e.ports.length === 0)).toBe(false);
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
