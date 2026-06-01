/**
 * Reads per-project theme overrides from a `.hued` file in the session's cwd.
 *
 * Format (ini-style, very simple):
 *   # https://github.com/orochi235/hued
 *   background=#320053
 *
 * Returns null if the file is missing, malformed, or lacks a `background`
 * key.
 *
 * Caching uses the `.hued` file's mtime so subsequent reads short-circuit
 * when the file hasn't changed, but a real edit (or a `.hued` that didn't
 * exist before and now does) is picked up on the next call. This is what
 * makes the monitor's periodic theme poll cheap: hitting the same file
 * 10× a minute is one stat per call when nothing's changed.
 */

import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface PanelTheme {
  /** Original hex from .hued, e.g. "#320053". */
  background: string;
  /** "#fff" or "#000" picked to give readable contrast against the bg. */
  foreground: string;
}

interface CacheEntry {
  /** mtime in milliseconds. -1 means "the file didn't exist" — so a future
   * stat that finds the file present (or with a fresh mtime) invalidates.*/
  mtime: number;
  theme: PanelTheme | null;
}

// Cache keyed by the absolute path to the `.hued` file, not the cwd, so
// many cwds that share a single repo-level `.hued` collapse to one entry.
const cache = new Map<string, CacheEntry>();

export async function readPanelTheme(cwd: string): Promise<PanelTheme | null> {
  if (!cwd) return null;

  // Resolve which `.hued` to consult — cwd first; then main-worktree
  // fallback for sibling worktree checkouts. We accept the first one that
  // actually exists on disk; missing intermediates aren't cached here
  // (the per-path cache below handles that).
  const candidates = [path.join(cwd, '.hued')];
  const mainRoot = await mainWorktreeRoot(cwd);
  if (mainRoot && mainRoot !== cwd) candidates.push(path.join(mainRoot, '.hued'));

  for (const huedPath of candidates) {
    const theme = await readThemeFromPath(huedPath);
    if (theme) return theme;
  }
  return null;
}

async function readThemeFromPath(huedPath: string): Promise<PanelTheme | null> {
  let mtime: number;
  try {
    const st = await stat(huedPath);
    mtime = st.mtimeMs;
  } catch {
    cache.set(huedPath, { mtime: -1, theme: null });
    return null;
  }
  const cached = cache.get(huedPath);
  if (cached && cached.mtime === mtime) return cached.theme;

  let text: string;
  try {
    text = await readFile(huedPath, 'utf8');
  } catch {
    cache.set(huedPath, { mtime: -1, theme: null });
    return null;
  }

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
  cache.set(huedPath, { mtime, theme });
  return theme;
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
