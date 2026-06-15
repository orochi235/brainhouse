/**
 * Pure slice helper for lazy scroll-back. Given a panel's full
 * chronological event list (as parsed from its JSONL) and the uuid of
 * the oldest event the client currently holds, return the `limit`
 * events immediately preceding it.
 */
import type { Event } from './parser.js';

export interface HistorySlice {
  events: Event[];
  /** True iff there are still older events before the returned slice. */
  hasMore: boolean;
}

export function sliceHistory(all: Event[], beforeUuid: string, limit: number): HistorySlice {
  const idx = all.findIndex((e) => e.uuid === beforeUuid);
  if (idx <= 0) return { events: [], hasMore: false };
  const start = Math.max(0, idx - limit);
  return { events: all.slice(start, idx), hasMore: start > 0 };
}
