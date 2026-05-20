/**
 * Panel ordering and per-panel flags. Each hook holds canonical client state
 * (optimistic UI) and optionally writes through to the server-side
 * `intentions` table via a `persist` callback, so manual drag order,
 * pin, and wide flags survive a server restart.
 *
 * Hooks accept an optional `initial` to seed from server-loaded intentions.
 * When omitted, behavior matches the pre-persistence default: in-memory only.
 */

import { useCallback, useState } from 'react';

interface OrderOpts {
  /** Sparse manual_order values, keyed by panel id. Lower = earlier. */
  initial?: Map<string, number>;
  persist?: (id: string, manual_order: number | null) => void;
}

export function usePanelOrder(opts: OrderOpts = {}) {
  const { initial, persist } = opts;
  const [order, setOrder] = useState<string[]>(() => orderFromIntentions(initial));

  const moveBefore = useCallback(
    (sourceId: string, targetId: string, knownIds: string[]) => {
      setOrder((current) => {
        const next = reorder(current, knownIds, sourceId, targetId);
        // Write through every position whose place actually changed.
        if (persist) {
          for (let i = 0; i < next.length; i++) {
            const id = next[i];
            if (id && current.indexOf(id) !== i) persist(id, i);
          }
        }
        return next;
      });
    },
    [persist],
  );

  return { order, moveBefore };
}

interface FlagOpts {
  initial?: Set<string>;
  persist?: (id: string, value: boolean) => void;
}

export function useWidePanels(opts: FlagOpts = {}) {
  const { initial, persist } = opts;
  const [wide, setWide] = useState<Set<string>>(() => new Set(initial ?? []));

  const toggleWide = useCallback(
    (id: string) => {
      setWide((current) => {
        const next = new Set(current);
        const newValue = !next.has(id);
        if (newValue) next.add(id);
        else next.delete(id);
        persist?.(id, newValue);
        return next;
      });
    },
    [persist],
  );

  return { wide, toggleWide };
}

export function usePinnedPanels(opts: FlagOpts = {}) {
  const { initial, persist } = opts;
  const [pinned, setPinned] = useState<Set<string>>(() => new Set(initial ?? []));

  const togglePin = useCallback(
    (id: string) => {
      setPinned((current) => {
        const next = new Set(current);
        const newValue = !next.has(id);
        if (newValue) next.add(id);
        else next.delete(id);
        persist?.(id, newValue);
        return next;
      });
    },
    [persist],
  );

  return { pinned, togglePin };
}

/** Materialize a manual_order Map into an ordered array of panel ids. */
function orderFromIntentions(initial: Map<string, number> | undefined): string[] {
  if (!initial || initial.size === 0) return [];
  return [...initial.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
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
