import { describe, expect, it } from 'vitest';
import { deriveWorktree, worktreeColor } from './worktree.ts';

describe('deriveWorktree', () => {
  it('detects the Claude Code .claude/worktrees convention', () => {
    expect(deriveWorktree('/Users/mike/src/weasel/.claude/worktrees/color-via-router')).toEqual({
      repo: 'weasel',
      name: 'color-via-router',
      key: 'weasel/color-via-router',
    });
  });

  it('detects nested file paths under a worktree', () => {
    expect(
      deriveWorktree('/Users/mike/src/weasel/.claude/worktrees/color-via-router/client/src'),
    ).toEqual({
      repo: 'weasel',
      name: 'color-via-router',
      key: 'weasel/color-via-router',
    });
  });

  it('detects the .worktrees sibling convention', () => {
    expect(deriveWorktree('/Users/mike/src/brainhouse/.worktrees/feature-x')).toEqual({
      repo: 'brainhouse',
      name: 'feature-x',
      key: 'brainhouse/feature-x',
    });
  });

  it('detects a sibling -worktrees directory', () => {
    expect(deriveWorktree('/Users/mike/src/brainhouse-worktrees/feature-y')).toEqual({
      repo: 'brainhouse',
      name: 'feature-y',
      key: 'brainhouse/feature-y',
    });
  });

  it('returns null for a plain repo cwd', () => {
    expect(deriveWorktree('/Users/mike/src/brainhouse')).toBeNull();
  });

  it('returns null for null/empty', () => {
    expect(deriveWorktree(null)).toBeNull();
    expect(deriveWorktree(undefined)).toBeNull();
    expect(deriveWorktree('')).toBeNull();
  });
});

describe('worktreeColor', () => {
  it('is deterministic per key', () => {
    expect(worktreeColor('weasel/foo')).toBe(worktreeColor('weasel/foo'));
  });
  it('differs across distinct keys', () => {
    expect(worktreeColor('weasel/foo')).not.toBe(worktreeColor('weasel/bar'));
  });
  it('returns a valid hsl() string', () => {
    expect(worktreeColor('x/y')).toMatch(/^hsl\(\d+ 65% 55%\)$/);
  });
});
