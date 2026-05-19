/**
 * In-memory panel ordering and per-panel flags. Session state is transient —
 * we don't persist these across reloads. Panels not yet in the order go to
 * the end of the list (so newly-arrived sessions appear at the tail).
 */

import { useCallback, useState } from 'react';

export function usePanelOrder() {
  const [order, setOrder] = useState<string[]>([]);

  const moveBefore = useCallback((sourceId: string, targetId: string, knownIds: string[]) => {
    setOrder((current) => reorder(current, knownIds, sourceId, targetId));
  }, []);

  return { order, moveBefore };
}

export function useWidePanels() {
  const [wide, setWide] = useState<Set<string>>(() => new Set());

  const toggleWide = useCallback((id: string) => {
    setWide((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  return { wide, toggleWide };
}

export function usePinnedPanels() {
  const [pinned, setPinned] = useState<Set<string>>(() => new Set());

  const togglePin = useCallback((id: string) => {
    setPinned((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  return { pinned, togglePin };
}

/**
 * Compute a sorted list of panel ids by applying `order` as a preference,
 * then appending any `knownIds` not yet ordered (in their incoming order).
 */
export function sortByOrder(knownIds: string[], order: string[]): string[] {
  const known = new Set(knownIds);
  const used = new Set<string>();
  const out: string[] = [];
  for (const id of order) {
    if (known.has(id) && !used.has(id)) {
      out.push(id);
      used.add(id);
    }
  }
  for (const id of knownIds) {
    if (!used.has(id)) out.push(id);
  }
  return out;
}

export function reorder(
  current: string[],
  knownIds: string[],
  sourceId: string,
  targetId: string,
): string[] {
  if (sourceId === targetId) return current;
  // Start from the visible order so we operate on what the user actually sees.
  const base = sortByOrder(knownIds, current);
  const without = base.filter((id) => id !== sourceId);
  const targetIdx = without.indexOf(targetId);
  if (targetIdx === -1) return current;
  without.splice(targetIdx, 0, sourceId);
  return without;
}
