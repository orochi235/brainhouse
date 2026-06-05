/**
 * Derive worktree info from a session's cwd.
 *
 * Detected shapes (most specific first):
 *
 *   <repo-root>/.claude/worktrees/<name>            ← Claude Code's worktree convention
 *   <repo-root>/.worktrees/<name>
 *   <repo-root>-worktrees/<name>                    ← sibling-dir convention
 *   <repo-root>/worktrees/<name>                    ← generic fallback
 *
 * Returns null when the cwd doesn't look like a worktree (treat as "main
 * checkout"). The key is stable across panels in the same worktree so
 * UI grouping + color derivation agree across the app.
 */

export interface WorktreeInfo {
  /** Last path segment of the repo root, e.g. "weasel". */
  repo: string;
  /** Worktree leaf name, e.g. "color-via-router". */
  name: string;
  /** Stable identifier shared by all panels in the same worktree.
   * Currently `<repo>/<name>` — repo-qualified so two different repos
   * can't accidentally collide on a shared worktree name. */
  key: string;
}

const PATTERNS: Array<{ re: RegExp }> = [
  { re: /^(.*?)\/\.claude\/worktrees\/([^/]+)(?:\/|$)/ },
  { re: /^(.*?)\/\.worktrees\/([^/]+)(?:\/|$)/ },
  { re: /^(.*?)-worktrees\/([^/]+)(?:\/|$)/ },
  { re: /^(.*?)\/worktrees\/([^/]+)(?:\/|$)/ },
];

export function deriveWorktree(cwd: string | null | undefined): WorktreeInfo | null {
  if (!cwd) return null;
  for (const { re } of PATTERNS) {
    const m = cwd.match(re);
    if (!m) continue;
    const repoPath = m[1] ?? '';
    const name = m[2] ?? '';
    if (!repoPath || !name) continue;
    const repo = repoPath.split('/').filter(Boolean).pop() ?? '';
    if (!repo) continue;
    return { repo, name, key: `${repo}/${name}` };
  }
  return null;
}

/**
 * Deterministic CSS color for a worktree. Same key → same hue across
 * sessions, runs, panels. Uses a small djb2 hash for stability without
 * needing a crypto dependency, and a fixed saturation/lightness so
 * colors play well alongside the panel chrome.
 */
export function worktreeColor(key: string): string {
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) | 0;
  const hue = ((h % 360) + 360) % 360;
  return `hsl(${hue} 65% 55%)`;
}

/** Parse a `#RRGGBB` hex color into HSL components. Returns null on
 * non-hex input. */
function hexToHsl(hex: string): { h: number; s: number; l: number } | null {
  const m = hex.match(/^#([0-9a-f]{6})$/i);
  if (!m || !m[1]) return null;
  const r = parseInt(m[1].slice(0, 2), 16) / 255;
  const g = parseInt(m[1].slice(2, 4), 16) / 255;
  const b = parseInt(m[1].slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let hue = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) hue = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue *= 60;
  }
  return { h: hue, s: s * 100, l: l * 100 };
}

/** Turn an arbitrary color (hex or already-hsl string) into a
 * badge-friendly color: same hue, but with saturation and lightness
 * clamped to floors so dark / desaturated themes still pop on a small
 * chip. Brainhouse's deep-violet panel theme #320053 would otherwise
 * render as near-black; this lifts it to a vibrant purple while
 * keeping the same hue identity. */
export function badgeColor(input: string, minS = 65, minL = 55): string {
  const hsl = hexToHsl(input);
  if (!hsl) return input;
  return `hsl(${Math.round(hsl.h)} ${Math.max(hsl.s, minS)}% ${Math.max(hsl.l, minL)}%)`;
}
