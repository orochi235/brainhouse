import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const HOOK = new URL('./post-tool-use-bash.mjs', import.meta.url).pathname;
const run = (input, home) => spawnSync(process.execPath, [HOOK], {
  input: JSON.stringify(input), env: { ...process.env, HOME: home }, encoding: 'utf8',
});

describe('post-tool-use-bash hook', () => {
  let home;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'bh-')); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it('records bash_id_map for backgrounded Bash', () => {
    run({
      session_id: 's4',
      tool_name: 'Bash',
      tool_use_id: 'tu_42',
      tool_input: { command: 'npm run dev', run_in_background: true },
      tool_response: { bash_id: 'bg_1' },
    }, home);
    const rec = JSON.parse(readFileSync(join(home, '.brainhouse/events/s4.jsonl'), 'utf8').trim());
    expect(rec.kind).toBe('bash_id_map');
    expect(rec.tool_use_id).toBe('tu_42');
    expect(rec.bash_id).toBe('bg_1');
    expect(rec.session_id).toBe('s4');
  });

  it('no-ops for foreground Bash', () => {
    run({
      session_id: 's5',
      tool_name: 'Bash',
      tool_use_id: 'tu_43',
      tool_input: { command: 'ls' },
      tool_response: { stdout: 'a\nb\n' },
    }, home);
    expect(existsSync(join(home, '.brainhouse/events/s5.jsonl'))).toBe(false);
  });
});
