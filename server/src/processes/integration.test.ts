import { describe, it, expect } from 'vitest';
import { ProcessTracker } from './index.js';
import type { ProcessRow } from './reconciler.js';

describe('tracker → events end-to-end', () => {
  it('emits upsert then delete', async () => {
    let phase = 0;
    const t = new ProcessTracker({
      listProcesses: async () =>
        phase === 0
          ? [
              { pid: 50, ppid: 1, start_ts: 0, comm: 'claude', command: 'claude' },
              {
                pid: 100,
                ppid: 50,
                start_ts: 0,
                comm: 'node',
                command: 'node /p/node_modules/vite/bin/vite.js',
              },
            ]
          : [{ pid: 50, ppid: 1, start_ts: 0, comm: 'claude', command: 'claude' }],
      listListeningPorts: async () => [],
      now: () => (phase === 0 ? 5 : 100 + phase),
    });
    const events: Array<['up', number] | ['del', string]> = [];
    t.on('upsert', (r: ProcessRow) => events.push(['up', r.pid]));
    t.on('delete', (id: string) => events.push(['del', id]));
    t.handleHookRecord({
      kind: 'session_pid',
      session_id: 's1',
      pid: 50,
      ppid: 1,
      cwd: '/p',
      start_ts: 0,
      ts: 0,
    });
    await t.tickOnce();
    phase = 1;
    await t.tickOnce();
    phase = 2;
    await t.tickOnce();
    expect(events.find(([k]) => k === 'up')).toBeDefined();
    expect(events.find(([k]) => k === 'del')).toBeDefined();
  });
});
