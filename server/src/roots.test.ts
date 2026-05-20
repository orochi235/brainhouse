import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PREFS, type Prefs } from './prefs.js';
import { defaultRoots, resolveRoots } from './roots.js';

function withRoots(...paths: string[]): Prefs {
  return {
    ...DEFAULT_PREFS,
    roots: paths.map((p) => ({ path: p })),
  };
}

describe('roots', () => {
  let savedEnv: string | undefined;
  beforeEach(() => {
    savedEnv = process.env.BRAINHOUSE_ROOTS;
    delete process.env.BRAINHOUSE_ROOTS;
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.BRAINHOUSE_ROOTS;
    else process.env.BRAINHOUSE_ROOTS = savedEnv;
  });

  it('default is ~/.claude/projects', () => {
    expect(defaultRoots()).toEqual([path.join(os.homedir(), '.claude', 'projects')]);
  });

  it('resolveRoots prefers BRAINHOUSE_ROOTS over prefs and defaults', () => {
    process.env.BRAINHOUSE_ROOTS = '/a:/b';
    expect(resolveRoots(withRoots('/x'))).toEqual(['/a', '/b']);
  });

  it('resolveRoots returns prefs.roots when no env override', () => {
    expect(resolveRoots(withRoots('/x', '/y'))).toEqual(['/x', '/y']);
  });

  it('resolveRoots falls back to defaultRoots when prefs is empty', () => {
    expect(resolveRoots(withRoots())).toEqual(defaultRoots());
  });
});
