/**
 * Resolve which transcript roots the watcher should monitor right now.
 *
 * Used at startup and on every prefs.update so the hot-swap and the
 * cold-boot paths agree. Priority:
 *   env override (BRAINHOUSE_ROOTS, colon-separated) > prefs.roots >
 *   built-in defaults (`~/.claude/projects`, `~/.claude-pw/projects`).
 */

import os from 'node:os';
import path from 'node:path';
import type { Prefs } from './prefs.js';

export function defaultRoots(): string[] {
  const home = os.homedir();
  return [path.join(home, '.claude', 'projects'), path.join(home, '.claude-pw', 'projects')];
}

export function resolveRoots(prefs: Prefs): string[] {
  const envRoots = process.env.BRAINHOUSE_ROOTS?.split(':');
  if (envRoots) return envRoots;
  const prefRoots = prefs.roots.map((r) => r.path);
  return prefRoots.length > 0 ? prefRoots : defaultRoots();
}
