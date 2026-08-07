import { describe, expect, it } from 'vitest';
import { ITERM_REVEAL_SCRIPT_FOCUS, ITERM_REVEAL_SCRIPT_NOFOCUS } from './native.js';

describe('iTerm reveal scripts', () => {
  it('focus variant activates; no-focus variant raises via AXRaise instead', () => {
    expect(ITERM_REVEAL_SCRIPT_FOCUS).toContain('activate');
    expect(ITERM_REVEAL_SCRIPT_NOFOCUS).not.toContain('activate');
    expect(ITERM_REVEAL_SCRIPT_NOFOCUS).toContain('AXRaise');
  });
});
