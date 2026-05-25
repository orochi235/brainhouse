/**
 * Worktree-aware grid grouping helpers, consumed by App.tsx when
 * `prefs.workspace.groupByWorktree` is on.
 *
 *   groupByWorktreeKey     — stable-sorts panels so same-worktree panels
 *                            cluster together; panels with no worktree
 *                            sink to the end as a single "trunk" group.
 *   interleaveWorktreeSeparators — produces a render list that injects a
 *                            full-width labeled separator above each
 *                            worktree group (none above the trunk).
 *
 * Both are pure functions over PanelState[] so they're unit-testable
 * without rendering the grid.
 */

import type { PanelState } from '../useDeltaStream.ts';
import { deriveWorktree } from './worktree.ts';

export function groupByWorktreeKey(panels: PanelState[]): PanelState[] {
  const groups = new Map<string, PanelState[]>();
  const trunk: PanelState[] = [];
  for (const p of panels) {
    const wt = deriveWorktree(p.cwd);
    if (!wt) {
      trunk.push(p);
      continue;
    }
    const arr = groups.get(wt.key) ?? [];
    arr.push(p);
    groups.set(wt.key, arr);
  }
  return [...Array.from(groups.values()).flat(), ...trunk];
}

export type GridRenderItem =
  | { kind: 'panel'; panel: PanelState }
  | { kind: 'separator'; key: string; label: string };

export function interleaveWorktreeSeparators(
  panels: PanelState[],
  enabled: boolean,
): GridRenderItem[] {
  if (!enabled) return panels.map((p) => ({ kind: 'panel', panel: p }));
  const out: GridRenderItem[] = [];
  let prevKey: string | null = null;
  for (const p of panels) {
    const wt = deriveWorktree(p.cwd);
    const key = wt?.key ?? null;
    if (key !== null && key !== prevKey) {
      out.push({ kind: 'separator', key, label: wt?.name ?? key });
    }
    out.push({ kind: 'panel', panel: p });
    prevKey = key;
  }
  return out;
}
