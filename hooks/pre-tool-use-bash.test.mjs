import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const HOOK = new URL('./pre-tool-use-bash.mjs', import.meta.url).pathname;

function run(input, home) {
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(input),
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  });
}

describe('pre-tool-use-bash hook', () => {
  let home;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'bh-')); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it('records a bash_intent for a Bash call', () => {
    const res = run({
      session_id: 's2',
      tool_name: 'Bash',
      tool_input: { command: 'npm run dev', run_in_background: true, description: 'start dev' },
      cwd: '/tmp/proj',
    }, home);
    expect(res.status).toBe(0);
    const rec = JSON.parse(readFileSync(join(home, '.brainhouse/events/s2.jsonl'), 'utf8').trim());
    expect(rec.kind).toBe('bash_intent');
    expect(rec.session_id).toBe('s2');
    expect(rec.command).toBe('npm run dev');
    expect(rec.run_in_background).toBe(true);
    expect(rec.cwd).toBe('/tmp/proj');
    expect(typeof rec.ts).toBe('number');
  });

  it('ignores non-Bash tools', () => {
    const res = run({ session_id: 's2', tool_name: 'Read', tool_input: { file_path: '/x' } }, home);
    expect(res.status).toBe(0);
    expect(existsSync(join(home, '.brainhouse/events/s2.jsonl'))).toBe(false);
  });

  it('defaults run_in_background to false when absent', () => {
    run({ session_id: 's3', tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/x' }, home);
    const rec = JSON.parse(readFileSync(join(home, '.brainhouse/events/s3.jsonl'), 'utf8').trim());
    expect(rec.run_in_background).toBe(false);
  });
});
