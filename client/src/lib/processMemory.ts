import type { PanelState } from '../useDeltaStream.ts';
import type { ProcessRow } from '../useProcesses.ts';

/** Idle cutoffs offered by the reclaimable-memory banner. Deliberately the
 * same boundaries `IdleCell` buckets its colors on, so the banner's
 * threshold and the Idle column's shading never disagree. */
export const IDLE_THRESHOLDS = [
  { seconds: 300, label: '5m' },
  { seconds: 1800, label: '30m' },
  { seconds: 7200, label: '2h' },
  { seconds: 21600, label: '6h' },
  { seconds: 86400, label: '24h' },
  { seconds: 604800, label: '7d' },
] as const;

export const DEFAULT_IDLE_THRESHOLD_S = 7200;

/** Sum of `rss_kb` over a row and every descendant. The visited guard is
 * load-bearing: `childrenByPid` is built from ppid/ancestor links that can
 * form a cycle after a reparent, and without it this recurses until the
 * stack blows. */
export function subtreeRss(row: ProcessRow, childrenByPid: Map<number, ProcessRow[]>): number {
  let total = 0;
  const seen = new Set<number>();
  const stack: ProcessRow[] = [row];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur || seen.has(cur.pid)) continue;
    seen.add(cur.pid);
    total += cur.rss_kb;
    for (const kid of childrenByPid.get(cur.pid) ?? []) stack.push(kid);
  }
  return total;
}

export type Reclaimable = {
  /** Sessions whose trees are counted — the banner's filter uses this set. */
  sessionIds: Set<string>;
  totalKb: number;
  treeCount: number;
};

/**
 * Total memory held by session trees idle past `thresholdSeconds`.
 *
 * A root with no `session_id`, or one whose session has no panel, is
 * EXCLUDED rather than treated as idle — a missing panel means brainhouse
 * has no activity record for that session (it predates the server, or is
 * unwatched), which is not the same as knowing it has been quiet.
 */
export function reclaimable(
  roots: ProcessRow[],
  childrenByPid: Map<number, ProcessRow[]>,
  panels: Map<string, PanelState>,
  thresholdSeconds: number,
  now: number,
): Reclaimable {
  const sessionIds = new Set<string>();
  let totalKb = 0;
  let treeCount = 0;
  for (const root of roots) {
    if (!root.session_id) continue;
    const panel = panels.get(root.session_id);
    if (!panel) continue;
    if (now - panel.last_event_at < thresholdSeconds) continue;
    sessionIds.add(root.session_id);
    totalKb += subtreeRss(root, childrenByPid);
    treeCount++;
  }
  return { sessionIds, totalKb, treeCount };
}
