import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const HOOK = new URL('./session-start-procs.mjs', import.meta.url).pathname;

describe('session-start-procs hook', () => {
  let home;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'bh-')); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it('writes a session_pid record with our ppid', () => {
    const payload = JSON.stringify({ session_id: 'sess-1', source: 'startup' });
    const res = spawnSync(process.execPath, [HOOK], {
      input: payload,
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe('');
    const path = join(home, '.brainhouse', 'events', 'sess-1.jsonl');
    expect(existsSync(path)).toBe(true);
    const rec = JSON.parse(readFileSync(path, 'utf8').trim());
    expect(rec.kind).toBe('session_pid');
    expect(rec.session_id).toBe('sess-1');
    expect(typeof rec.pid).toBe('number');
    expect(rec.pid).toBe(process.pid); // we are the parent of the spawned node
    expect(typeof rec.ts).toBe('number');
    expect(typeof rec.start_ts).toBe('number');
    expect(typeof rec.cwd).toBe('string');
  });

  it('exits 0 with no record when session_id is missing', () => {
    const res = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({}),
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);
    expect(existsSync(join(home, '.brainhouse'))).toBe(false);
  });
});
