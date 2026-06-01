/**
 * Derive a short, human-friendly project label from a working directory.
 *
 * When `repoRoot` is supplied (server-stamped, set when `cwd` is inside a
 * git checkout), the label is just the repo's leaf segment — `pw/cke` and
 * `pw/screener` are real standalone repos, not "pw subdirs", so they
 * should read as `cke` and `screener`. Subdir-under-repo info is dropped
 * intentionally; the panel header already shows the full cwd in its
 * tooltip when needed.
 *
 * When `repoRoot` is missing (non-git scratch dirs), the two-segment
 * fallback survives because there's no other way to distinguish nested
 * non-repo paths.
 *
 *   /Users/mike/src/pw/cke         repoRoot=/Users/mike/src/pw/cke  → cke
 *   /Users/mike/src/brainhouse     repoRoot=/Users/mike/src/brainhouse → brainhouse
 *   /Users/mike/src/pw/template    (no repoRoot)                   → pw/template
 *   /Users/mike/src                                                → ~/src
 *   /Users/mike                                                    → ~
 *   /tmp/foo                                                       → /tmp/foo
 */

const HOME_RE = /^\/Users\/[^/]+(\/|$)/;

export function projectLabel(
  cwd: string | null | undefined,
  repoRoot?: string | null,
): string {
  if (!cwd) return '';
  if (repoRoot) {
    const leaf = repoRoot.split('/').filter(Boolean).pop();
    if (leaf) return leaf;
  }
  const collapsed = cwd.replace(HOME_RE, '~/').replace(/\/$/, '') || '~';
  // For deeply-nested src paths, prefer the last two segments past ~/src/.
  const srcIdx = collapsed.indexOf('~/src/');
  if (srcIdx !== -1) {
    const tail = collapsed.slice(srcIdx + '~/src/'.length);
    const parts = tail.split('/').filter(Boolean);
    if (parts.length === 0) return '~/src';
    if (parts.length === 1) return parts[0] ?? '';
    return parts.slice(-2).join('/');
  }
  // Outside ~/src: keep up to the last two path segments.
  const parts = collapsed.split('/').filter(Boolean);
  if (collapsed.startsWith('~')) {
    if (parts.length <= 1) return '~';
    return `~/${parts.slice(-1)[0]}`;
  }
  if (parts.length <= 2) return collapsed;
  return `/${parts.slice(-2).join('/')}`;
}
