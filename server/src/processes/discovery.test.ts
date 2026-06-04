import { describe, it, expect } from 'vitest';
import { ProcessTracker } from './index.js';
import { runStartupDiscovery } from './discovery.js';

describe('runStartupDiscovery', () => {
  it('seeds rows for currently-listening ports with discovered provenance', async () => {
    const tracker = new ProcessTracker({
      listProcesses: async () => [
        { pid: 4242, ppid: 1, start_ts: 0, comm: 'postgres', command: '/usr/local/bin/postgres -D /var/pg' },
      ],
      listListeningPorts: async () => [
        { pid: 4242, ports: [{ proto: 'TCP' as const, addr: '0.0.0.0', port: 5432 }] },
      ],
      now: () => 100,
    });
    tracker.addSubscriber();
    await runStartupDiscovery(tracker);
    const rows = tracker.snapshot();
    const pg = rows.find(r => r.pid === 4242);
    expect(pg).toBeDefined();
    expect(pg!.provenance).toBe('discovered');
    expect(pg!.ports[0].port).toBe(5432);
  });
});
