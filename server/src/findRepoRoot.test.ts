import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findRepoRoot } from './session.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bh-reporoot-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('findRepoRoot', () => {
  const repo = path.join(tmp, 'weasel');
  mkdirSync(path.join(repo, '.git', 'worktrees', 'agent-a1'), { recursive: true });
  mkdirSync(path.join(repo, 'src'), { recursive: true });
  const wt = path.join(repo, '.claude', 'worktrees', 'agent-a1');
  mkdirSync(path.join(wt, 'src'), { recursive: true });
  writeFileSync(
    path.join(wt, '.git'),
    `gitdir: ${path.join(repo, '.git', 'worktrees', 'agent-a1')}\n`,
  );

  it('resolves a subdirectory to its checkout', () => {
    expect(findRepoRoot(path.join(repo, 'src'))).toBe(repo);
  });

  it('resolves a linked worktree to its main checkout', () => {
    expect(findRepoRoot(path.join(wt, 'src'))).toBe(repo);
  });

  it('resolves a worktree that has since been removed to the repo around it', () => {
    expect(findRepoRoot(path.join(repo, '.claude', 'worktrees', 'agent-gone'))).toBe(repo);
  });

  it('resolves a deleted sibling-dir worktree to the repo beside it', () => {
    expect(findRepoRoot(path.join(tmp, 'weasel-wt', 'release-icons'))).toBe(repo);
    expect(findRepoRoot(path.join(tmp, 'weasel-worktrees', 'x', 'src'))).toBe(repo);
  });

  it('keeps a .git file it cannot read as a pointer as its own root', () => {
    const odd = path.join(tmp, 'odd');
    mkdirSync(odd);
    writeFileSync(path.join(odd, '.git'), 'gitdir: /elsewhere/modules/sub\n');
    expect(findRepoRoot(odd)).toBe(odd);
  });
});
