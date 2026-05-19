/**
 * Client-side window-management for panels. We never mutate server state —
 * the agents are the source of truth. Two states live here:
 *
 *   - `clientMini`: a *live* panel the user dismissed. It moves to the
 *     mini-tray (alongside server-side mini panels) but its underlying
 *     session keeps running. Draggable back to the grid.
 *
 *   - `hiddenAt`: a non-live panel the user dismissed. It disappears
 *     entirely; reappears automatically if the server sends new activity
 *     (`last_event_at > hideAt`).
 *
 * Both live in memory only — session state is transient. Entries get pruned
 * when the server forgets the panel for real (committed `panel_remove`).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PanelState } from '../useDeltaStream.ts';

const STALE_ON_FIRST_SIGHT_SECONDS = 30;

export function usePanelDismissal(panels: Map<string, PanelState>) {
  const [hiddenAt, setHiddenAt] = useState<Record<string, number>>({});
  const [clientMini, setClientMini] = useState<Set<string>>(() => new Set());
  const seenIdsRef = useRef<Set<string>>(new Set());

  // First-sight auto-mini: bootstrap replays panels with old `last_event_at`.
  // If a panel appears with no recent activity, route it straight to the dock
  // so a reload doesn't dump 15 stale panels in the grid. The user can still
  // dig them out of the tray.
  useEffect(() => {
    const cutoff = Date.now() / 1000 - STALE_ON_FIRST_SIGHT_SECONDS;
    const fresh: string[] = [];
    for (const p of panels.values()) {
      if (seenIdsRef.current.has(p.id)) continue;
      seenIdsRef.current.add(p.id);
      if (p.last_event_at < cutoff) fresh.push(p.id);
    }
    if (fresh.length > 0) {
      setClientMini((cur) => {
        const next = new Set(cur);
        for (const id of fresh) next.add(id);
        return next;
      });
    }
  }, [panels]);

  // Prune entries for panels the server has fully forgotten.
  useEffect(() => {
    for (const id of seenIdsRef.current) {
      if (!panels.has(id)) seenIdsRef.current.delete(id);
    }
    setHiddenAt((cur) => {
      let changed = false;
      const next: Record<string, number> = {};
      for (const [id, t] of Object.entries(cur)) {
        if (panels.has(id)) next[id] = t;
        else changed = true;
      }
      return changed ? next : cur;
    });
    setClientMini((cur) => {
      const next = new Set<string>();
      let changed = false;
      for (const id of cur) {
        if (panels.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : cur;
    });
  }, [panels]);

  const dismiss = useCallback((panel: PanelState) => {
    // Panels already in the tray (server-side mini) → fully hide; there's
    // nowhere else for them to go. Everything else (live or done in the
    // grid) → send to the tray. New activity will pop a hidden panel back.
    if (panel.status === 'mini') {
      setHiddenAt((cur) => ({ ...cur, [panel.id]: Date.now() / 1000 }));
    } else {
      setClientMini((cur) => {
        const next = new Set(cur);
        next.add(panel.id);
        return next;
      });
    }
  }, []);

  const restore = useCallback((id: string) => {
    setClientMini((cur) => {
      if (!cur.has(id)) return cur;
      const next = new Set(cur);
      next.delete(id);
      return next;
    });
    setHiddenAt((cur) => {
      if (!(id in cur)) return cur;
      const next = { ...cur };
      delete next[id];
      return next;
    });
  }, []);

  const isHidden = useCallback(
    (panel: PanelState) => {
      const at = hiddenAt[panel.id];
      if (at === undefined) return false;
      return panel.last_event_at <= at;
    },
    [hiddenAt],
  );

  const isClientMini = useCallback((panel: PanelState) => clientMini.has(panel.id), [clientMini]);

  const dismissAll = useCallback(() => {
    const now = Date.now() / 1000;
    const nextHidden: Record<string, number> = {};
    for (const p of panels.values()) {
      nextHidden[p.id] = Math.max(p.last_event_at, now);
    }
    setHiddenAt(nextHidden);
    setClientMini(new Set());
  }, [panels]);

  return { dismiss, dismissAll, restore, isHidden, isClientMini };
}
