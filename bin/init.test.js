import { describe, it, expect } from 'vitest';
import { hookRegistry } from './init.js';

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
