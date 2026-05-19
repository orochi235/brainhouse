/**
 * Derive a short, human-friendly project label from a working directory.
 *
 *   /Users/mike/src/brainhouse        → brainhouse
 *   /Users/mike/src/pw/template       → pw/template
 *   /Users/mike/src                   → ~/src
 *   /Users/mike                       → ~
 *   /tmp/foo                          → /tmp/foo
 */

const HOME_RE = /^\/Users\/[^/]+(\/|$)/;

export function projectLabel(cwd: string | null | undefined): string {
  if (!cwd) return '';
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
