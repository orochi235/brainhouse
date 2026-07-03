import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PREFS, type Prefs } from './prefs.js';
import { defaultRoots, deriveAccountLabel, resolveRoots } from './roots.js';

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

  it('discovers every ~/.claude*/projects config dir', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-roots-'));
    fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
    fs.mkdirSync(path.join(home, '.claude-pw', 'projects'), { recursive: true });
    fs.mkdirSync(path.join(home, '.claude-msb', 'projects'), { recursive: true });
    // Noise that must be ignored: non-config dir, and a config dir
    // without a projects/ subdir.
    fs.mkdirSync(path.join(home, '.config'), { recursive: true });
    fs.mkdirSync(path.join(home, '.claude-empty'), { recursive: true });

    expect(defaultRoots(home).sort()).toEqual(
      [
        path.join(home, '.claude', 'projects'),
        path.join(home, '.claude-msb', 'projects'),
        path.join(home, '.claude-pw', 'projects'),
      ].sort(),
    );
  });

  it('falls back to ~/.claude/projects when nothing is discoverable', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-roots-'));
    expect(defaultRoots(home)).toEqual([path.join(home, '.claude', 'projects')]);
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

  it('narrows a .claude config-dir root to its projects subdir (fd-leak guard)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-roots-'));
    const cfg = path.join(home, '.claude-pw');
    fs.mkdirSync(path.join(cfg, 'projects'), { recursive: true });
    fs.mkdirSync(path.join(cfg, 'file-history'), { recursive: true });
    // A config dir passed whole must resolve to <cfg>/projects, never the
    // tree that also holds file-history/plugins/etc.
    expect(resolveRoots(withRoots(cfg))).toEqual([path.join(cfg, 'projects')]);
  });

  it('leaves a config-dir root without a projects subdir untouched', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-roots-'));
    const cfg = path.join(home, '.claude-empty');
    fs.mkdirSync(cfg, { recursive: true });
    expect(resolveRoots(withRoots(cfg))).toEqual([cfg]);
  });

  it('leaves a non-config custom root untouched even if it has a projects subdir', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-roots-'));
    const custom = path.join(home, 'my-transcripts');
    fs.mkdirSync(path.join(custom, 'projects'), { recursive: true });
    expect(resolveRoots(withRoots(custom))).toEqual([custom]);
  });
});

describe('deriveAccountLabel', () => {
  it('maps bare .claude to CC', () => {
    expect(deriveAccountLabel('/Users/mike/.claude/projects')).toBe('CC');
    expect(deriveAccountLabel('/Users/mike/.claude')).toBe('CC');
  });

  it('upper-cases the suffix of a .claude-<suffix> dir', () => {
    expect(deriveAccountLabel('/Users/mike/.claude-pw/projects')).toBe('PW');
    expect(deriveAccountLabel('/Users/mike/.claude-msb')).toBe('MSB');
  });

  it('returns null when no config-dir segment is present', () => {
    expect(deriveAccountLabel('/Users/mike/src/brainhouse')).toBeNull();
    expect(deriveAccountLabel(null)).toBeNull();
    expect(deriveAccountLabel(undefined)).toBeNull();
  });
});
