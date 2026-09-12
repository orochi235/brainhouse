import { describe, expect, it } from 'vitest';
import { applyEnv, envRegistry, hookRegistry, isOurs, removeEnv } from './init.js';

describe('hookRegistry', () => {
  it('includes the three process-tracking hooks with correct events and matchers', () => {
    const reg = hookRegistry('/x/hooks');

    const sessionStart = reg.find(
      (r) => r.event === 'SessionStart' && /session-start-procs/.test(r.command),
    );
    expect(sessionStart).toBeDefined();
    expect(sessionStart?.role).toBe('procs-session-start');

    const preBash = reg.find(
      (r) => r.event === 'PreToolUse' && /pre-tool-use-bash/.test(r.command),
    );
    expect(preBash).toBeDefined();
    expect(preBash?.matcher).toBe('Bash');

    const postBash = reg.find(
      (r) => r.event === 'PostToolUse' && /post-tool-use-bash/.test(r.command),
    );
    expect(postBash).toBeDefined();
    expect(postBash?.matcher).toBe('Bash');
  });
});

describe('envRegistry', () => {
  it('opts into the task-list tools', () => {
    expect(envRegistry()).toEqual([{ key: 'CLAUDE_CODE_ENABLE_TODO_TOOLS', value: '1' }]);
  });
});

describe('applyEnv', () => {
  const reg = [{ key: 'CLAUDE_CODE_ENABLE_TODO_TOOLS', value: '1' }];

  it('writes the key and records ownership', () => {
    const s = applyEnv({}, reg);
    expect(s.env).toEqual({ CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' });
    expect(s.brainhouse.ownedEnv).toEqual({ CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' });
  });

  it('round-trips: strip after apply restores the original settings', () => {
    const before = { env: { FOO: 'bar' } };
    const after = removeEnv(applyEnv(structuredClone(before), reg));
    expect(after).toEqual(before);
  });

  it('leaves no empty env or marker object behind when nothing else is set', () => {
    expect(removeEnv(applyEnv({}, reg))).toEqual({});
  });

  it('keeps a key the user has since edited', () => {
    const s = applyEnv({}, reg);
    s.env.CLAUDE_CODE_ENABLE_TODO_TOOLS = '0';
    expect(removeEnv(s).env).toEqual({ CLAUDE_CODE_ENABLE_TODO_TOOLS: '0' });
  });

  it('ignores an unrecognized ownership record', () => {
    const s = { env: { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' }, brainhouse: { ownedEnv: ['x'] } };
    expect(removeEnv(s).env).toEqual({ CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' });
  });
});

describe('hookRegistry: handoff-resume', () => {
  it('is registered on SessionStart with the `clear` matcher', () => {
    const entry = hookRegistry('/x/hooks').find((r) => r.role === 'handoff-resume');
    expect(entry).toBeDefined();
    expect(entry?.event).toBe('SessionStart');
    expect(entry?.matcher).toBe('clear');
  });

  it('every hook script in the table has a registry row, so init never strips one it cannot re-add', () => {
    const roles = new Set(hookRegistry('/x/hooks').map((r) => r.role));
    for (const role of ['dispatcher', 'handoff-resume', 'context-reminder']) {
      expect(roles).toContain(role);
    }
  });
});

describe('isOurs', () => {
  const dir = '/repo/hooks';
  const tagged = { brainhouse: 'dispatcher', hooks: [{ command: 'node "/elsewhere/x.mjs"' }] };
  const legacyUntagged = { hooks: [{ command: `node "${dir}/dispatcher.mjs" stop` }] };
  const foreign = { hooks: [{ command: 'node "/somebody/else/hook.mjs"' }] };

  it('claims tagged entries', () => expect(isOurs(tagged, dir)).toBe(true));
  it('claims untagged entries pointing at our hooks dir', () =>
    expect(isOurs(legacyUntagged, dir)).toBe(true));
  it('leaves hooks the user authored alone', () => expect(isOurs(foreign, dir)).toBe(false));
  it('leaves the PATH-export shell hook alone', () =>
    expect(isOurs({ matcher: 'startup', hooks: [{ command: 'echo export PATH=x' }] }, dir)).toBe(
      false,
    ));
});
