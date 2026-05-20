/**
 * Loads server-side `intentions` rows on mount and exposes seeded values
 * + a write-through `persist()` callback to the per-feature hooks
 * (`useWidePanels`, `usePinnedPanels`, `usePanelOrder`, `usePanelDismissal`).
 *
 * Wire-through:
 *   server (intentions table) → trpc.intentions.all
 *                              → seed each hook's initial state
 *   user change in a hook    → persist(id, patch)
 *                              → trpc.intentions.upsert (server merges with
 *                                its current row so a partial patch can't
 *                                clobber sibling fields)
 *
 * No optimistic-rollback handling — server writes are fire-and-forget. The
 * worst case if a write fails is the user's intent is in-memory only until
 * the next change to that panel, which is acceptable for UI state.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DismissalIntentions } from './hiddenPanels.ts';
import { trpc } from '../trpc.ts';

interface IntentionsRow {
  panel_id: string;
  pinned: boolean;
  wide: boolean;
  manual_order: number | null;
  user_mini: boolean;
  hidden_at: number | null;
  auto_mini_at: number | null;
}

export interface SeededIntentions {
  pinned: Set<string>;
  wide: Set<string>;
  order: Map<string, number>;
  dismissal: DismissalIntentions;
}

const EMPTY_INTENTIONS: SeededIntentions = {
  pinned: new Set(),
  wide: new Set(),
  order: new Map(),
  dismissal: { userMini: new Set(), hiddenAt: {}, autoMiniAt: {} },
};

export interface UseIntentionsReturn {
  ready: boolean;
  seeded: SeededIntentions;
  persist: (
    id: string,
    patch: {
      pinned?: boolean;
      wide?: boolean;
      manual_order?: number | null;
      user_mini?: boolean;
      hidden_at?: number | null;
      auto_mini_at?: number | null;
    },
  ) => void;
}

export function useIntentions(): UseIntentionsReturn {
  const [seeded, setSeeded] = useState<SeededIntentions>(EMPTY_INTENTIONS);
  const [ready, setReady] = useState(false);
  // Hold a ref to the latest seed so the persist function can compose
  // patches without becoming reactive on every change.
  const seedRef = useRef(seeded);
  seedRef.current = seeded;

  useEffect(() => {
    let cancelled = false;
    trpc.intentions.all
      .query()
      .then((rows) => {
        if (cancelled) return;
        setSeeded(materialize(rows));
        setReady(true);
      })
      .catch(() => {
        // Server unavailable / persistence disabled — keep defaults.
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = useCallback<UseIntentionsReturn['persist']>((id, patch) => {
    trpc.intentions.upsert.mutate({ panel_id: id, ...patch }).catch(() => {
      // Persistence is best-effort; user-visible state already updated.
    });
  }, []);

  return useMemo(() => ({ ready, seeded, persist }), [ready, seeded, persist]);
}

function materialize(rows: IntentionsRow[]): SeededIntentions {
  const out: SeededIntentions = {
    pinned: new Set(),
    wide: new Set(),
    order: new Map(),
    dismissal: { userMini: new Set(), hiddenAt: {}, autoMiniAt: {} },
  };
  for (const r of rows) {
    if (r.pinned) out.pinned.add(r.panel_id);
    if (r.wide) out.wide.add(r.panel_id);
    if (r.manual_order !== null) out.order.set(r.panel_id, r.manual_order);
    if (r.user_mini) out.dismissal.userMini?.add(r.panel_id);
    if (r.hidden_at !== null && out.dismissal.hiddenAt) {
      out.dismissal.hiddenAt[r.panel_id] = r.hidden_at;
    }
    if (r.auto_mini_at !== null && out.dismissal.autoMiniAt) {
      out.dismissal.autoMiniAt[r.panel_id] = r.auto_mini_at;
    }
  }
  return out;
}
