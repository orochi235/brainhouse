/**
 * Reads per-project theme overrides from a `.hued` file in the session's cwd.
 *
 * Format (ini-style, very simple):
 *   # https://github.com/orochi235/hued
 *   background=#320053
 *
 * Returns null if the file is missing, malformed, or lacks a `background`
 * key. Results are cached per cwd since the file shouldn't change often
 * during a single brainhouse run.
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface PanelTheme {
  /** Original hex from .hued, e.g. "#320053". */
  background: string;
  /** "#fff" or "#000" picked to give readable contrast against the bg. */
  foreground: string;
}

// Cache only successful reads — caching misses would prevent picking up a
// `.hued` that gets added after the first attempt within one process
// lifetime.
const cache = new Map<string, PanelTheme>();

export async function readPanelTheme(cwd: string): Promise<PanelTheme | null> {
  if (!cwd) return null;
  const hit = cache.get(cwd);
  if (hit) return hit;

  // Try the cwd first; if there's no `.hued` there, fall back to the main
  // worktree (git common-dir's parent). Worktrees are typically siblings
  // of the main repo, so a plain walk-up wouldn't reach the shared
  // `.hued`. This is the only fallback location we consider — `.hued`
  // sitting outside both cwd and the main worktree isn't a thing.
  let text = await readHued(cwd);
  if (text === null) {
    const mainRoot = await mainWorktreeRoot(cwd);
    if (mainRoot && mainRoot !== cwd) text = await readHued(mainRoot);
  }
  if (text === null) return null;

  let theme: PanelTheme | null = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === 'background' && isHexColor(value)) {
      theme = buildTheme(value);
    }
  }

  if (theme) cache.set(cwd, theme);
  return theme;
}

async function readHued(dir: string): Promise<string | null> {
  try {
    return await readFile(path.join(dir, '.hued'), 'utf8');
  } catch {
    return null;
  }
}

async function mainWorktreeRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { timeout: 1000 },
    );
    const commonDir = stdout.trim();
    if (!commonDir) return null;
    // `--git-common-dir` returns the shared `.git` directory of the main
    // worktree; its parent is the main worktree's root. (For bare repos
    // it's the repo dir itself, which won't have a `.hued` — harmless.)
    return path.dirname(commonDir);
  } catch {
    return null;
  }
}

function isHexColor(value: string): boolean {
  return /^#[0-9a-fA-F]{3,8}$/.test(value);
}

function buildTheme(background: string): PanelTheme | null {
  const rgb = hexToRgb(background);
  if (!rgb) return null;
  const yiq = (rgb.r * 299 + rgb.g * 587 + rgb.b * 114) / 1000;
  // Sanity guard: extremely pale colors would wash the white text out and
  // give barely-visible bubbles. Refuse those rather than silently render
  // something unreadable.
  if (yiq > 220) return null;
  const foreground = yiq > 128 ? '#000' : '#fff';
  return { background, foreground };
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  let h = hex.replace('#', '');
  if (h.length === 3) {
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  }
  if (h.length !== 6) return null;
  const r = Number.parseInt(h.slice(0, 2), 16);
  const g = Number.parseInt(h.slice(2, 4), 16);
  const b = Number.parseInt(h.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
  return { r, g, b };
}

// Test-only: forget cached lookups so .hued edits show up on the next read.
export function clearPanelThemeCache(): void {
  cache.clear();
}
