/**
 * Helper for wrapping React state mutations in the View Transitions API.
 * Used at promote/restore call sites where a panel moves between the
 * dock and the grid — the browser snapshots the pre-state DOM, lets
 * React commit synchronously inside the callback, then crossfades to
 * the post-state DOM in one composited frame instead of two paints.
 *
 * Falls through to a plain callback invocation when the API isn't
 * available (Firefox / Safari without the feature flag) or when the
 * tab has prefers-reduced-motion set.
 */

import { flushSync } from 'react-dom';

type StartViewTransition = (cb: () => void) => unknown;

export function withViewTransition(fn: () => void): void {
  const start = (document as Document & { startViewTransition?: StartViewTransition })
    .startViewTransition;
  const reduced =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (!start || reduced) {
    fn();
    return;
  }
  start.call(document, () => {
    flushSync(fn);
  });
}
