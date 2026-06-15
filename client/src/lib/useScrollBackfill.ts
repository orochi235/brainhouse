import type { Event } from '@server/parser.ts';
import { type RefObject, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { trpc } from '../trpc.ts';

const HISTORY_PAGE = 500;
/** Fire backfill when the scroll container is within this many px of top. */
const TOP_TRIGGER_PX = 200;

interface Args {
  bodyRef: RefObject<HTMLElement | null>;
  panelId: string;
  liveEvents: Event[];
  /** Whether the server has older events than the live window holds. */
  hasMore: boolean;
}

export interface ScrollBackfill {
  mergedEvents: Event[];
  loadOlder: () => Promise<void>;
  reset: () => void;
  /** Attach to the scroll container's onScroll. */
  onScroll: () => void;
}

export function useScrollBackfill({ bodyRef, panelId, liveEvents, hasMore }: Args): ScrollBackfill {
  const [older, setOlder] = useState<Event[]>([]);
  const [moreBelowCursor, setMoreBelowCursor] = useState(true);
  const inFlight = useRef(false);
  // scrollHeight captured just before a prepend, so we can restore position.
  const anchorRef = useRef<number | null>(null);

  // A new panel resets all transient history state.
  const lastPanel = useRef(panelId);
  if (lastPanel.current !== panelId) {
    lastPanel.current = panelId;
    setOlder([]);
    setMoreBelowCursor(true);
    inFlight.current = false;
  }

  const mergedEvents = useMemo(() => [...older, ...liveEvents], [older, liveEvents]);

  const loadOlder = useCallback(async () => {
    if (inFlight.current) return;
    if (!hasMore && !moreBelowCursor) return;
    const cursor = (older[0] ?? liveEvents[0])?.uuid;
    if (!cursor) return;
    inFlight.current = true;
    anchorRef.current = bodyRef.current?.scrollHeight ?? null;
    try {
      const res = await trpc.panelHistory.query({
        panelId,
        beforeUuid: cursor,
        limit: HISTORY_PAGE,
      });
      // tRPC infers a structurally-equivalent but nominally-distinct Event
      // union across the client boundary; the server returns Event[].
      const fetched = res.events as Event[];
      if (fetched.length) setOlder((prev) => [...fetched, ...prev]);
      setMoreBelowCursor(res.hasMore);
    } finally {
      inFlight.current = false;
    }
  }, [bodyRef, hasMore, liveEvents, moreBelowCursor, older, panelId]);

  const reset = useCallback(() => {
    setOlder([]);
    setMoreBelowCursor(true);
  }, []);

  // Restore scroll position after older events are prepended so the
  // viewport stays anchored on the same event instead of jumping.
  // `older` is the intentional trigger — the effect re-runs on each
  // prepend to consume the captured anchor, even though it isn't read.
  // biome-ignore lint/correctness/useExhaustiveDependencies: older drives the re-run.
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (el && anchorRef.current != null) {
      el.scrollTop += el.scrollHeight - anchorRef.current;
      anchorRef.current = null;
    }
  }, [older, bodyRef]);

  const onScroll = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    if (el.scrollTop <= TOP_TRIGGER_PX) void loadOlder();
  }, [bodyRef, loadOlder]);

  return { mergedEvents, loadOlder, reset, onScroll };
}
