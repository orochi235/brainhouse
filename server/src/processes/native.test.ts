import { describe, it, expect } from 'vitest';
import { listProcesses, listListeningPorts, signalProcess, parsePsOutput, parseLsofOutput } from './native.js';

describe('parsePsOutput', () => {
  it('extracts pid/ppid/start/comm/command', () => {
    const sample = `  PID  PPID                      LSTART COMM             COMMAND
    1     0 Thu Jun  5 09:00:00 2025 launchd          /sbin/launchd
12345 12300 Thu Jun  5 10:30:15 2025 node             /usr/local/bin/node /x/bin/vite
`;
    const rows = parsePsOutput(sample);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      pid: 12345, ppid: 12300, comm: 'node',
      command: '/usr/local/bin/node /x/bin/vite',
    });
    expect(typeof rows[1].start_ts).toBe('number');
  });
});

describe('parseLsofOutput', () => {
  it('parses -F pPn into per-pid listening sockets', () => {
    const sample = `p4823
PTCP
n127.0.0.1:5173
PTCP
n*:24678
p4901
PTCP
n0.0.0.0:8000
`;
    const rows = parseLsofOutput(sample);
    expect(rows).toEqual([
      { pid: 4823, ports: [{ proto: 'TCP', addr: '127.0.0.1', port: 5173 }, { proto: 'TCP', addr: '*', port: 24678 }] },
      { pid: 4901, ports: [{ proto: 'TCP', addr: '0.0.0.0', port: 8000 }] },
    ]);
  });
});

describe('listProcesses (integration)', () => {
  it('returns this process', async () => {
    const rows = await listProcesses();
    const me = rows.find(r => r.pid === process.pid);
    expect(me).toBeDefined();
    expect(me!.command).toContain('node');
  });
});

describe('signalProcess', () => {
  it('refuses pids <= 1000', async () => {
    await expect(signalProcess(1, 'TERM')).rejects.toThrow(/refused/i);
  });
});
