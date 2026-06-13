# Bounded live event window + lazy JSONL backfill

**Status:** design approved, pending implementation plan
**Date:** 2026-06-13

## Problem

The client retains every event it has ever received. `useDeltaStream`'s
reducer appends to a per-panel `Event[]` on each `event_append` delta
(`useDeltaStream.ts:80`) and never trims it. A panel's events are freed
only when the server sends `panel_remove`. For long-lived or busy
sessions this grows without bound — observed as a single Chrome renderer
at ~4 GB. These are full parsed `Event`s (tool inputs/outputs, message
bodies) plus the `ViewItem`s derived from them by the transform pipeline.

This is data retention, not a React/DOM leak: a freshly loaded tab is
flat at ~40 MB with a GC-stable ~28k DOM nodes over 45s. The growth is
purely the accumulated in-memory event arrays.

The server already caps its own in-memory copy at
`MAX_EVENTS_PER_PANEL = 10_000` with chunked eviction
(`session.ts:309`), and only streams/snapshots that capped set. The
client is the only unbounded party. Full history is persisted to the
JSONL transcripts on disk (`events_index` in SQLite holds metadata
only — "full content stays in the JSONL on disk").

## Goal

Bound client memory **and** let the user scroll back farther than the
in-memory window — ideally to session start — by lazily re-fetching
older events from the JSONL on demand. Memory stays flat; deep
scrollback does not become standing memory.

Scope: every surface that renders events (grid panel cards,
expanded/broken-out panels, TraceTab).

## Approach (A): bounded live window + ephemeral backfill buffer

Bound the live window at the data layer (fixes memory globally), and
hold lazily-fetched older events in transient per-view state that is
dropped when the user returns to the tail or the view unmounts.

Rejected alternatives:
- **Single growable shared array with high-water eviction** — deep
  scrollback in one expanded panel inflates the array every surface
  shares; trim-on-return is heuristic and races stick-to-bottom.
- **Virtualize the DOM, rely on server cap only** — the leak is the
  retained `Event[]`, not the DOM (node count is GC-stable), so
  virtualization doesn't address it.

## Design

### 1. Server — on-demand history procedure

New tRPC query `panelHistory`:

- **Input:** `{ panelId: string, beforeUuid: string, limit: number }` —
  return the `limit` events immediately preceding `beforeUuid`.
- **Behavior:** resolve `panelId → source JSONL path` (expose the
  watcher's existing file registry; `panel.id` is the session id and
  transcripts are `<session_id>.jsonl`), re-parse via the existing
  `parseJsonlToPanel`, locate `beforeUuid`, return the preceding `limit`
  events.
- **Output:** `{ events: Event[]; hasMore: boolean }` where `hasMore`
  is false once the start of the file is reached.
- v1 re-parses the whole file per call — acceptable for a debounced,
  on-scroll action against local disk. Byte-offset ranged reads (the
  hook-event tailer already uses `createReadStream(file, {start, end})`)
  and a parsed-file cache are noted future optimizations, not v1.
- **Edge cases:** missing/pruned JSONL or unknown cursor →
  `{ events: [], hasMore: false }` (UI stops quietly). Replay
  (drag-dropped) panels were loaded whole and report `hasMore: false`.
- **Open item for the plan:** subagent panels may share their parent's
  JSONL file; the `panelId → path` resolver must handle that.

### 2. Client — bound the live window (`useDeltaStream`)

- Add `LIVE_WINDOW` (≈1,500). In the reducer's `event_append` (and on
  snapshot receipt), once `events.length > LIVE_WINDOW`, drop the oldest
  chunk — mirror the server's chunked eviction so splices are
  occasional, not per-event. This alone bounds the standing memory,
  everywhere, immediately.
- "Is there older history?" is derivable from the existing
  `PanelDto.event_count > events.length` — no new bookkeeping.

### 3. Client — shared backfill hook

`useScrollBackfill({ bodyRef, panelId, liveEvents, hasMore })`, used by
each render surface (each owns its own scroll container ref):

- Watches the scroll container; when `scrollTop` nears the top **and**
  `hasMore`, fires `panelHistory` (cursor = oldest currently-rendered
  uuid). Single in-flight request, debounced.
- Holds fetched `older: Event[]` in transient state; returns
  `mergedEvents = [...older, ...liveEvents]`.
- **Scroll anchoring:** a `useLayoutEffect` records `scrollHeight`
  before prepend and restores `scrollTop += Δheight` after, so the
  viewport stays put.
- **Memory reclaim:** when the user returns to the tail (stick-to-bottom
  re-arms) or the surface unmounts, `older` is dropped. Deep scrollback
  never becomes standing memory.

### 4. Integration

`EventList` is the shared render seam. Each surface (panel cards,
expanded/broken-out, TraceTab) calls `useScrollBackfill` with its scroll
ref and passes `mergedEvents` to `EventList`. The existing
stick-to-bottom auto-scroll (`PanelCard.tsx` `stickToBottomRef`) is
untouched: backfill only triggers when scrolled up, and anchoring keeps
the viewport far from the bottom so it won't re-pin.

## Testing

- **Reducer:** appending past `LIVE_WINDOW` trims oldest, preserves tail
  order, and evicts in chunks (not one-at-a-time).
- **Server:** fixture JSONL → correct slice before cursor; `hasMore`
  correct at the start-of-file boundary; missing file / unknown cursor
  handled gracefully.
- **Hook:** near-top scroll triggers exactly one fetch (no duplicate
  in-flight); prepend anchors scroll position; return-to-tail clears the
  backfill buffer.
- **Integration:** `EventList` renders `older ++ live` in correct
  chronological order with stable keys.

## Tunables (finalize in plan)

- `LIVE_WINDOW` ≈ 1,500 events/panel
- `HISTORY_PAGE` ≈ 500 events/fetch
- top-trigger threshold ≈ 200px
