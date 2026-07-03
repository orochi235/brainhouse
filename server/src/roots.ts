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
  if (envRoots) return envRoots.map(narrowConfigDirRoot);
  const prefRoots = prefs.roots.map((r) => narrowConfigDirRoot(r.path));
  return prefRoots.length > 0 ? prefRoots : defaultRoots();
}

/**
 * A root pointed at a `.claude…` *config* dir (e.g. `~/.claude-pw`) rather than
 * its `projects` subdir makes the watcher recurse the ENTIRE config tree —
 * `file-history`, `plugins`, `tasks`, `session-env`, tens of thousands of
 * files. chokidar (v4, no fsevents on this platform) holds one open fd per
 * watched file, so that exhausts the process's fd limit; once no fds are free,
 * libuv can't allocate child-stdio pipes and every `child_process` spawn fails
 * `EBADF`. Transcripts only ever live under `<configDir>/projects`, so narrow
 * such a root to that subdir. Non-config roots (an explicit custom path) pass
 * through untouched. */
export function narrowConfigDirRoot(p: string): string {
  if (!/^\.claude(?:-.+)?$/.test(path.basename(p))) return p;
  const projects = path.join(p, 'projects');
  try {
    if (fs.statSync(projects).isDirectory()) return projects;
  } catch {
    // No projects subdir — leave as-is; walk() over an empty/odd dir is cheap.
  }
  return p;
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
