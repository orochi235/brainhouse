/**
 * Per-panel scroll-position memory for refresh recovery.
 *
 * Stored in `sessionStorage` so it survives a page refresh (which is what
 * we want) but clears on tab close (which is also what we want — re-opening
 * brainhouse in a fresh tab should start clean, not at some buried scroll
 * position from a previous session).
 *
 * Entries carry a `savedAt` timestamp and expire after a short window. The
 * intent: a refresh restores instantly; re-opening a panel from the dock
 * ten minutes later still snaps to the bottom (the assertion's default
 * behavior). The TTL distinguishes "refresh" from "deliberate re-open".
 */

const KEY_PREFIX = 'bh:scroll:';
/** How long after the last save we'll still honor a stored position. */
const TTL_MS = 60_000;

interface ScrollMemo {
  scrollTop: number;
  savedAt: number;
}

function safeStorage(): Storage | null {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null;
  } catch {
    return null;
  }
}

export function loadScrollPosition(panelId: string): number | null {
  const s = safeStorage();
  if (!s) return null;
  const raw = s.getItem(KEY_PREFIX + panelId);
  if (!raw) return null;
  try {
    const memo = JSON.parse(raw) as ScrollMemo;
    if (Date.now() - memo.savedAt > TTL_MS) {
      s.removeItem(KEY_PREFIX + panelId);
      return null;
    }
    return memo.scrollTop;
  } catch {
    return null;
  }
}

export function saveScrollPosition(panelId: string, scrollTop: number): void {
  const s = safeStorage();
  if (!s) return;
  const memo: ScrollMemo = { scrollTop, savedAt: Date.now() };
  try {
    s.setItem(KEY_PREFIX + panelId, JSON.stringify(memo));
  } catch {
    // Quota / disabled / private mode: silently no-op. Worst case is the
    // refresh snaps to bottom instead of restoring — same as TTL expiry.
  }
}

export function clearScrollPosition(panelId: string): void {
  const s = safeStorage();
  if (!s) return;
  try {
    s.removeItem(KEY_PREFIX + panelId);
  } catch {
    // ignore
  }
}
