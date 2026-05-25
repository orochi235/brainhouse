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
