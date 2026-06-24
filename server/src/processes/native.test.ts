import { describe, it, expect } from 'vitest';
import { execWithRetry, getSpawnDiagnostics, resetSpawnDiagnostics, listProcesses, listListeningPorts, signalProcess, parsePsOutput, parseLsofOutput } from './native.js';

function spawnError(code: string): Error {
  const e = new Error(`spawn ${code}`) as Error & { code: string; syscall: string; errno: number };
  e.code = code;
  e.syscall = 'spawn';
  e.errno = -9;
  return e;
}

describe('execWithRetry', () => {
  it('retries a transient spawn EBADF, then succeeds', async () => {
    let calls = 0;
    const result = await execWithRetry(
      async () => {
        calls++;
        if (calls < 3) throw spawnError('EBADF');
        return 'ok';
      },
      { attempts: 3, delayMs: 0 },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('catches a SYNCHRONOUS spawn throw (libuv raises EBADF before the promise)', async () => {
    let calls = 0;
    // Not async — throws inline, mirroring how execFileAsync can throw before
    // returning a promise when uv_spawn loses an fd race.
    const fn = (): Promise<string> => {
      calls++;
      if (calls < 2) throw spawnError('EBADF');
      return Promise.resolve('ok');
    };
    expect(await execWithRetry(fn, { attempts: 3, delayMs: 0 })).toBe('ok');
    expect(calls).toBe(2);
  });

  it('rethrows a non-transient spawn error without retrying', async () => {
    let calls = 0;
    await expect(
      execWithRetry(
        async () => {
          calls++;
          throw spawnError('EACCES');
        },
        { attempts: 3, delayMs: 0 },
      ),
    ).rejects.toThrow(/EACCES/);
    expect(calls).toBe(1);
  });

  it('gives up after the final attempt on a persistent transient error', async () => {
    let calls = 0;
    await expect(
      execWithRetry(
        async () => {
          calls++;
          throw spawnError('EBADF');
        },
        { attempts: 3, delayMs: 0 },
      ),
    ).rejects.toThrow(/EBADF/);
    expect(calls).toBe(3);
  });
});

describe('execWithRetry diagnostics', () => {
  it('counts transient retries that eventually succeed, without marking them exhausted', async () => {
    resetSpawnDiagnostics();
    let calls = 0;
    await execWithRetry(
      async () => {
        calls++;
        if (calls < 3) throw spawnError('EBADF');
        return 'ok';
      },
      { attempts: 3, delayMs: 0, label: 'ps' },
    );
    const d = getSpawnDiagnostics();
    expect(d.transient.EBADF).toBe(2); // two failed attempts before success
    expect(d.exhausted.EBADF ?? 0).toBe(0);
    expect(d.inFlight).toBe(0); // gauge balanced
  });

  it('records the command label + attempt count when retries are exhausted', async () => {
    resetSpawnDiagnostics();
    await expect(
      execWithRetry(async () => { throw spawnError('EBADF'); }, { attempts: 3, delayMs: 0, label: 'ps' }),
    ).rejects.toThrow(/EBADF/);
    const d = getSpawnDiagnostics();
    expect(d.exhausted.EBADF).toBe(1);
    expect(d.recent.at(-1)).toMatchObject({ label: 'ps', code: 'EBADF', attempts: 3 });
  });

  it('serializes spawns so concurrent callers never overlap (kills the EBADF fd race)', async () => {
    resetSpawnDiagnostics();
    let active = 0;
    let maxActive = 0;
    const task = (label: string) =>
      execWithRetry(
        () =>
          new Promise<string>((resolve) => {
            active++;
            maxActive = Math.max(maxActive, active);
            setTimeout(() => {
              active--;
              resolve(label);
            }, 5);
          }),
        { label },
      );
    // Fire all three the way a tick + port sweep would — concurrently.
    await Promise.all([task('ps'), task('lsof:ports'), task('lsof:cwd')]);
    // The queue lets only one spawn run at a time, so the fd race never arises.
    expect(maxActive).toBe(1);
    const d = getSpawnDiagnostics();
    expect(d.peakInFlight).toBe(1);
    expect(d.inFlight).toBe(0);
  });
});

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
