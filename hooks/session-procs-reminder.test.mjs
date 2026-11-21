import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const HOOK = new URL('./session-procs-reminder.mjs', import.meta.url).pathname;
const START = new URL('./session-start-procs.mjs', import.meta.url).pathname;

const own = (pid) => ({ pid, command: '/Users/x/.local/bin/claude', uptime_s: 900, ports: [] });
const vite = { pid: 99991, bash_id: 'bash_1', command: 'node vite', uptime_s: 300, ports: [] };

describe('session-procs-reminder hook', () => {
  let dir;
  let server;
  let rows;
  let env;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bh-procs-'));
    server = http.createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ rows }));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    env = {
      ...process.env,
      HOME: dir,
      BRAINHOUSE_PORT: String(server.address().port),
      BRAINHOUSE_HOOK_STATE_DIR: join(dir, 'state'),
      BRAINHOUSE_EVENTS_DIR: join(dir, 'events'),
    };
  });
  afterEach(async () => {
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (file = HOOK, payload = { session_id: 's1' }) =>
    new Promise((resolve, reject) => {
      const child = execFile(process.execPath, [file], { env }, (err, stdout) =>
        err
          ? reject(err)
          : resolve(stdout.trim() ? JSON.parse(stdout).hookSpecificOutput.additionalContext : ''),
      );
      child.stdin.end(JSON.stringify(payload));
    });

  it('never lists the session itself or the processes above it', async () => {
    rows = [own(process.pid), own(process.ppid)];
    expect(await run()).toBe('');
  });

  it('speaks once per change, not once per prompt', async () => {
    rows = [own(process.pid), vite];
    const first = await run();
    expect(first).toContain('bash_1');
    expect(first).not.toContain(`pid ${process.pid}`);
    rows = [own(process.pid), { ...vite, uptime_s: 400 }];
    expect(await run()).toBe('');
    rows = [own(process.pid)];
    expect(await run()).toContain('have all exited');
    expect(await run()).toBe('');
  });

  it('repeats an unchanged list after SessionStart', async () => {
    rows = [vite];
    expect(await run()).toContain('bash_1');
    expect(await run()).toBe('');
    await run(START, { session_id: 's1', source: 'compact' });
    expect(await run()).toContain('bash_1');
  });
});
