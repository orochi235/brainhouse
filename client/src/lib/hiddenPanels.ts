/**
 * Client-side window-management for panels. We never mutate server state —
 * the agents are the source of truth. Three states live here:
 *
 *   - `userMini`: the user *explicitly* dismissed this panel. Sticky —
 *     stays in the dock even when new activity arrives. The user-intent
 *     trumps server churn.
 *
 *   - `autoMiniAt`: this panel was *auto-routed* to the dock on first
 *     sight because it was stale on reload (or because the server moved
 *     it to mini for idleness — see below). Self-clears when activity
 *     bumps `last_event_at` past the recorded timestamp. The user can
 *     still drag it back manually.
 *
 *   - `hiddenAt`: the user dismissed a panel that was already in the
 *     tray, which is "fully hide". Same `last_event_at` resurrection
 *     rule as autoMiniAt, but the panel disappears entirely instead of
 *     sitting in the dock.
 *
 * All three live in memory only. Entries get pruned when the server
 * forgets the panel for real (committed `panel_remove`).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PanelState } from '../useDeltaStream.ts';

const STALE_ON_FIRST_SIGHT_SECONDS = 30;

export interface DismissalIntentions {
  userMini?: Set<string>;
  hiddenAt?: Record<string, number>;
  autoMiniAt?: Record<string, number>;
  /** Panels the user has explicitly pulled out of the dock. The allocator
   * treats these as unconditional primary (like pinned, but cleared as
   * soon as the user dismisses again). */
  userKept?: Set<string>;
}

export interface DismissalOpts {
  initial?: DismissalIntentions;
  /** Persist a single panel's dismissal-related intentions. Called on every
   * mutation; throttle/debounce upstream if needed. */
  persist?: (
    id: string,
    patch: {
      user_mini?: boolean;
      hidden_at?: number | null;
      auto_mini_at?: number | null;
      user_kept?: boolean;
    },
  ) => void;
}

export function usePanelDismissal(panels: Map<string, PanelState>, opts: DismissalOpts = {}) {
  const { initial, persist } = opts;
  const [hiddenAt, setHiddenAt] = useState<Record<string, number>>(() => ({
    ...(initial?.hiddenAt ?? {}),
  }));
  const [userMini, setUserMini] = useState<Set<string>>(() => new Set(initial?.userMini ?? []));
  const [autoMiniAt, setAutoMiniAt] = useState<Record<string, number>>(() => ({
    ...(initial?.autoMiniAt ?? {}),
  }));
  const [userKept, setUserKept] = useState<Set<string>>(
    () => new Set(initial?.userKept ?? []),
  );
  const seenIdsRef = useRef<Set<string>>(new Set());
  const touched = useRef(false);
  // Re-seed when `initial` arrives async from useIntentions (empty on mount
  // → real values once trpc resolves). Skip if the user has already
  // dismissed/restored, so the click isn't clobbered by the late snapshot.
  useEffect(() => {
    if (touched.current) return;
    setHiddenAt({ ...(initial?.hiddenAt ?? {}) });
    setUserMini(new Set(initial?.userMini ?? []));
    setAutoMiniAt({ ...(initial?.autoMiniAt ?? {}) });
    setUserKept(new Set(initial?.userKept ?? []));
  }, [initial]);

  // First-sight auto-mini: bootstrap replays panels with old
  // `last_event_at`. If a panel appears with no recent activity, route it
  // straight to the dock so a reload doesn't dump 15 stale panels in the
  // grid. Stamped with a timestamp so a future event automatically
  // promotes it back to the grid — *unlike* userMini, which is sticky.
  useEffect(() => {
    const now = Date.now() / 1000;
    const cutoff = now - STALE_ON_FIRST_SIGHT_SECONDS;
    const fresh: Record<string, number> = {};
    for (const p of panels.values()) {
      if (seenIdsRef.current.has(p.id)) continue;
      seenIdsRef.current.add(p.id);
      if (p.last_event_at < cutoff) {
        fresh[p.id] = Math.max(p.last_event_at, now);
      }
    }
    if (Object.keys(fresh).length > 0) {
      setAutoMiniAt((cur) => ({ ...cur, ...fresh }));
    }
  }, [panels]);

  // Server-driven mini transition: when a panel's status flips
  // live|done → mini, stamp `autoMiniAt[id]` so the slot allocator's
  // grid-backfill rule can't immediately pull it back. The existing
  // last_event_at comparison in `isClientMini` lifts the stamp on the
  // next fresh event. First-sight panels (no prior observation) don't
  // re-fire this path — the bootstrap stale-on-first-sight effect above
  // already handles them.
  const prevStatusRef = useRef<Map<string, PanelState['status']>>(new Map());
  useEffect(() => {
    const now = Date.now() / 1000;
    const fresh: Record<string, number> = {};
    for (const p of panels.values()) {
      const prev = prevStatusRef.current.get(p.id);
      prevStatusRef.current.set(p.id, p.status);
      if (prev === undefined) continue;
      if (prev !== 'mini' && p.status === 'mini') {
        fresh[p.id] = Math.max(p.last_event_at, now);
      }
    }
    // Prune entries for ids the server has forgotten.
    for (const id of prevStatusRef.current.keys()) {
      if (!panels.has(id)) prevStatusRef.current.delete(id);
    }
    if (Object.keys(fresh).length > 0) {
      setAutoMiniAt((cur) => ({ ...cur, ...fresh }));
      for (const [id, at] of Object.entries(fresh)) {
        persist?.(id, { auto_mini_at: at });
      }
    }
  }, [panels, persist]);

  // Prune entries for panels the server has fully forgotten.
  useEffect(() => {
    for (const id of seenIdsRef.current) {
      if (!panels.has(id)) seenIdsRef.current.delete(id);
    }
    setHiddenAt((cur) => pruneMap(cur, panels));
    setAutoMiniAt((cur) => pruneMap(cur, panels));
    setUserKept((cur) => {
      const next = new Set<string>();
      let changed = false;
      for (const id of cur) {
        if (panels.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : cur;
    });
    setUserMini((cur) => {
      const next = new Set<string>();
      let changed = false;
      for (const id of cur) {
        if (panels.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : cur;
    });
  }, [panels]);

  const dismiss = useCallback(
    (panel: PanelState) => {
      touched.current = true;
      // Dismissing always clears any manually-primary intent the user had
      // expressed earlier — the gesture is "send this back to the dock".
      setUserKept((cur) => {
        if (!cur.has(panel.id)) return cur;
        const next = new Set(cur);
        next.delete(panel.id);
        return next;
      });
      // Panels already in the tray (server-side mini) → fully hide; there's
      // nowhere else for them to go. Everything else (live or done in the
      // grid) → send to the tray as userMini. Auto-mini entries get
      // upgraded to userMini so the user's manual intent overrides the
      // self-clearing behavior.
      if (panel.status === 'mini') {
        const at = Date.now() / 1000;
        setHiddenAt((cur) => ({ ...cur, [panel.id]: at }));
        persist?.(panel.id, { hidden_at: at, user_kept: false });
      } else {
        setUserMini((cur) => {
          const next = new Set(cur);
          next.add(panel.id);
          return next;
        });
        setAutoMiniAt((cur) => {
          if (!(panel.id in cur)) return cur;
          const next = { ...cur };
          delete next[panel.id];
          return next;
        });
        persist?.(panel.id, {
          user_mini: true,
          auto_mini_at: null,
          user_kept: false,
        });
      }
    },
    [persist],
  );

  const restore = useCallback(
    (id: string) => {
      touched.current = true;
      setUserMini((cur) => {
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
      setAutoMiniAt((cur) => {
        if (!(id in cur)) return cur;
        const next = { ...cur };
        delete next[id];
        return next;
      });
      // Mark as manually primary so the allocator gives it a grid slot
      // unconditionally — otherwise a freshly-restored server-mini panel
      // (which transitions to `done`, not `live`) would be left in the
      // dock when pinned + live already saturate the slot budget.
      setUserKept((cur) => {
        if (cur.has(id)) return cur;
        const next = new Set(cur);
        next.add(id);
        return next;
      });
      persist?.(id, {
        user_mini: false,
        hidden_at: null,
        auto_mini_at: null,
        user_kept: true,
      });
    },
    [persist],
  );

  const isHidden = useCallback(
    (panel: PanelState) => {
      const at = hiddenAt[panel.id];
      if (at === undefined) return false;
      return panel.last_event_at <= at;
    },
    [hiddenAt],
  );

  /** True when the panel should render in the dock instead of the grid,
   * for *client*-side reasons (user dismissed it or first-sight auto-mini).
   * Independent of `panel.status === 'mini'` (server-side idleness), which
   * the layout handles separately. An auto-mini entry stops matching as
   * soon as `last_event_at` advances past the routing timestamp, so a
   * resumed session pops back to the grid automatically. */
  const isClientMini = useCallback(
    (panel: PanelState) => {
      if (userMini.has(panel.id)) return true;
      const at = autoMiniAt[panel.id];
      if (at !== undefined && panel.last_event_at <= at) return true;
      return false;
    },
    [userMini, autoMiniAt],
  );

  const isUserKept = useCallback(
    (panel: PanelState) => userKept.has(panel.id),
    [userKept],
  );

  const dismissAll = useCallback(() => {
    const now = Date.now() / 1000;
    const nextHidden: Record<string, number> = {};
    for (const p of panels.values()) {
      nextHidden[p.id] = Math.max(p.last_event_at, now);
      persist?.(p.id, { hidden_at: nextHidden[p.id], user_mini: false, auto_mini_at: null });
    }
    setHiddenAt(nextHidden);
    setUserMini(new Set());
    setAutoMiniAt({});
    setUserKept(new Set());
  }, [panels, persist]);

  return { dismiss, dismissAll, restore, isHidden, isClientMini, isUserKept };
}

function pruneMap(
  m: Record<string, number>,
  panels: Map<string, PanelState>,
): Record<string, number> {
  let changed = false;
  const next: Record<string, number> = {};
  for (const [id, t] of Object.entries(m)) {
    if (panels.has(id)) next[id] = t;
    else changed = true;
  }
  return changed ? next : m;
}
