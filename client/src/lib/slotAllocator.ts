/**
 * Slot allocator — decides which top-level panels claim a "guaranteed"
 * grid slot vs overflow into the mini tray.
 *
 * Why: a purely status-driven layout (`live` → grid, `mini` → tray) means
 * an empty grid with one or two mini tiles produces a big black void when
 * no work is currently in flight. The allocator fills a target of N
 * slots, pulling recent closed/idle panels back to primary placement
 * when there's no live work to compete for the space.
 *
 * Priority (top wins):
 *   1. Pinned panels — always primary. Hard rule; pins override the cap.
 *      If pins exceed N, every pin still shows and the fill step is skipped.
 *   2. Live unpinned panels — always primary, as many as exist.
 *   3. Fill remaining slots from closed/idle panels via per-repo
 *      round-robin (most-recent first per repo, then second-most-recent,
 *      etc.). If only one repo has activity, all slots fill from it.
 *
 * "Repo" is derived from cwd via `deriveWorktree`: worktrees of the same
 * repo collapse to one key so the diversification doesn't double-count
 * sibling worktrees. Panels with no cwd fall under a sentinel key and
 * round-robin among themselves.
 *
 * The user-intent overrides (pin, dismiss, client-mini) are applied
 * elsewhere — this function operates on the candidate pool the caller
 * passes in. Pinned panels should be passed via `pinned` so the
 * allocator can pre-claim slots for them.
 */

import { deriveWorktree } from './worktree.ts';

interface AllocCandidate {
  id: string;
  status: 'live' | 'done' | 'mini';
  cwd: string | null;
  /** Wall-clock seconds (matches `PanelState.last_event_at`). */
  last_event_at: number;
}

export interface AllocationResult {
  /** Panel ids that should occupy a grid slot. */
  primary: Set<string>;
  /** Panel ids that overflow to the tray. */
  overflow: Set<string>;
}

const NO_REPO = '__no_repo__';

function repoKey(cwd: string | null): string {
  if (!cwd) return NO_REPO;
  const wt = deriveWorktree(cwd);
  if (wt) return wt.repo;
  const seg = cwd.split('/').filter(Boolean).pop();
  return seg ?? NO_REPO;
}

/**
 * @param candidates Top-level panels eligible for placement. Subagents
 *   nested inside a parent's tray should NOT be passed here — they
 *   render inside the parent regardless of slot allocation.
 * @param pinned Panel ids the user has pinned. Always primary.
 * @param slotCount Target number of grid slots. 0 disables the allocator
 *   (everything returns to its caller's default placement — primary
 *   becomes the union of pinned + live, overflow gets everything else).
 */
export function allocateSlots(
  candidates: AllocCandidate[],
  pinned: Set<string>,
  slotCount: number,
): AllocationResult {
  const primary = new Set<string>();
  const overflow = new Set<string>();

  // 1. Pinned panels claim slots first (hard, overrides cap).
  for (const c of candidates) {
    if (pinned.has(c.id)) primary.add(c.id);
  }

  // 2. Live unpinned panels claim slots next (also unconditional).
  for (const c of candidates) {
    if (primary.has(c.id)) continue;
    if (c.status === 'live') primary.add(c.id);
  }

  if (slotCount <= 0) {
    // Allocator disabled — pinned + live in primary, everything else overflows.
    for (const c of candidates) if (!primary.has(c.id)) overflow.add(c.id);
    return { primary, overflow };
  }

  const budget = Math.max(0, slotCount - primary.size);

  // 3. Round-robin fill from the remaining pool. Group by repo, sort each
  //    bucket newest-first, then take one per repo per pass until the
  //    budget is exhausted or the pool is empty.
  const remaining = candidates.filter((c) => !primary.has(c.id));
  const byRepo = new Map<string, AllocCandidate[]>();
  for (const c of remaining) {
    const key = repoKey(c.cwd);
    const arr = byRepo.get(key) ?? [];
    arr.push(c);
    byRepo.set(key, arr);
  }
  for (const arr of byRepo.values()) {
    arr.sort((a, b) => b.last_event_at - a.last_event_at);
  }

  // Stable repo order: most-recently-active repo first (so the freshest
  // project's pass-1 pick beats older repos' pass-1 picks).
  const repoOrder = [...byRepo.keys()].sort((a, b) => {
    const aMax = byRepo.get(a)?.[0]?.last_event_at ?? 0;
    const bMax = byRepo.get(b)?.[0]?.last_event_at ?? 0;
    return bMax - aMax;
  });

  let claimed = 0;
  let pass = 0;
  while (claimed < budget) {
    let pickedThisPass = false;
    for (const repo of repoOrder) {
      if (claimed >= budget) break;
      const bucket = byRepo.get(repo);
      if (!bucket || pass >= bucket.length) continue;
      const pick = bucket[pass];
      if (!pick) continue;
      primary.add(pick.id);
      claimed += 1;
      pickedThisPass = true;
    }
    if (!pickedThisPass) break; // pool exhausted
    pass += 1;
  }

  for (const c of remaining) {
    if (!primary.has(c.id)) overflow.add(c.id);
  }
  return { primary, overflow };
}
