/**
 * Resolve which transcript roots the watcher should monitor right now.
 *
 * Used at startup and on every prefs.update so the hot-swap and the
 * cold-boot paths agree. Priority:
 *   env override (BRAINHOUSE_ROOTS, colon-separated) > prefs.roots >
 *   built-in default (a `projects` dir under every `~/.claude…` dir).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Prefs } from './prefs.js';

/** Every `projects` dir living under a `~/.claude…` config dir — one
 * per CLAUDE_CONFIG_DIR variant (`.claude`, `.claude-pw`, …). A user
 * with several accounts gets all of them watched without configuring
 * `roots` by hand. Falls back to the canonical `~/.claude/projects`
 * when discovery turns up nothing. */
export function defaultRoots(home: string = os.homedir()): string[] {
  let names: string[];
  try {
    names = fs
      .readdirSync(home, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\.claude(?:-.+)?$/.test(e.name))
      .map((e) => e.name);
  } catch {
    names = [];
  }
  const roots = names
    .map((name) => path.join(home, name, 'projects'))
    .filter((p) => {
      try {
        return fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
  return roots.length > 0 ? roots : [path.join(home, '.claude', 'projects')];
}

export function resolveRoots(prefs: Prefs): string[] {
  const envRoots = process.env.BRAINHOUSE_ROOTS?.split(':');
  if (envRoots) return envRoots;
  const prefRoots = prefs.roots.map((r) => r.path);
  return prefRoots.length > 0 ? prefRoots : defaultRoots();
}

/**
 * Derive an account badge label from a path that contains a
 * `.claude[-<suffix>]` config-dir segment — a transcript root
 * (`~/.claude-pw/projects`) or a raw CLAUDE_CONFIG_DIR (`~/.claude-pw`).
 *
 * `.claude` → "CC", `.claude-pw` → "PW", `.claude-msb` → "MSB". The
 * suffix is upper-cased so derived labels match the ones brainhouse has
 * historically persisted (old + new rows collapse to one account
 * instead of "PW" vs "pw"). Returns null when no config-dir segment is
 * present, so unrelated paths leave the badge blank.
 *
 * Only call this on root / config-dir paths, never on a session cwd — a
 * worktree under `<repo>/.claude/worktrees/…` would otherwise read as
 * the "CC" account.
 */
export function deriveAccountLabel(p: string | null | undefined): string | null {
  if (!p) return null;
  for (const seg of p.split(path.sep)) {
    const m = seg.match(/^\.claude(?:-(.+))?$/);
    if (!m) continue;
    return m[1] ? m[1].toUpperCase() : 'CC';
  }
  return null;
}
