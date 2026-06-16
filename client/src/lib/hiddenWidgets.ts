/**
 * Sticky hide state for *project widgets* (pseudo-ids `project:<repo>`).
 *
 * Why this is separate from `usePanelDismissal`: a widget is a synthesized
 * aggregate of a whole project, not a single session. Two properties of the
 * panel-dismissal machinery make it the wrong home for widget hiding:
 *
 *   1. `isHidden` resurrects a panel as soon as its `last_event_at` advances
 *      past the dismiss timestamp. A widget's `last_event_at` is the max over
 *      all its sessions, so for an *active* project it advances every second
 *      — the dismiss would undo itself within ~1s.
 *   2. `usePanelDismissal` prunes any id that isn't a live `panels` key.
 *      Widget ids are never in `panels`, so a widget entry would be pruned on
 *      the next snapshot.
 *
 * So widget hiding is a plain sticky set: presence = hidden, no timestamps,
 * no pruning. It persists through the intentions table (reusing the
 * `hidden_at` column on the shared `panel_id` namespace) and only clears on
 * an explicit `show`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface HiddenWidgetsOpts {
  /** Widget ids seeded as hidden from persisted intentions. */
  initial?: Set<string>;
  /** Write-through to the intentions table. `hidden` true → persist a
   * non-null `hidden_at`; false → clear it. */
  persist?: (id: string, hidden: boolean) => void;
}

export function useHiddenWidgets(opts: HiddenWidgetsOpts = {}) {
  const { initial, persist } = opts;
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(initial ?? []));
  // Re-seed when `initial` arrives async from useIntentions (empty on mount →
  // real values once trpc resolves), gated so a user click isn't clobbered by
  // the late snapshot.
  const touched = useRef(false);
  useEffect(() => {
    if (!touched.current) setHidden(new Set(initial ?? []));
  }, [initial]);

  const hide = useCallback(
    (id: string) => {
      touched.current = true;
      setHidden((cur) => {
        if (cur.has(id)) return cur;
        const next = new Set(cur);
        next.add(id);
        return next;
      });
      persist?.(id, true);
    },
    [persist],
  );

  const show = useCallback(
    (id: string) => {
      touched.current = true;
      setHidden((cur) => {
        if (!cur.has(id)) return cur;
        const next = new Set(cur);
        next.delete(id);
        return next;
      });
      persist?.(id, false);
    },
    [persist],
  );

  const isHiddenWidget = useCallback((id: string) => hidden.has(id), [hidden]);

  return { hide, show, isHiddenWidget };
}
