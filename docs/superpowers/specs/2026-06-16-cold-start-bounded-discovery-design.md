# Cold-start bounded discovery — design

_2026-06-16. Status: design, pending implementation._

## Problem

First prod run (`node server/dist/index.js`) surfaced ~600 session panels
at once, most with UUID-placeholder titles, disrupting the UI. Two causes
compound:

1. `monitor.hydrate()` (server/src/monitor.ts) restores **every** persisted
   panel from the DB into the live snapshot the client subscribes to.
2. `watcher.bootstrap()` (server/src/watcher.ts) walks **all** roots and
   ingests every `.jsonl` modified within a 30-min mtime window. The recent
   multi-account `defaultRoots()` change now walks `.claude` + `.claude-pw`
   + `.claude-msb`, multiplying the file/panel count.

Everything that's discovered surfaces **immediately**, with placeholder
titles (auto-title is async, debounced 30s). No recency or title gate sits
between discovery and the UI.

## Goals (agreed with Mike)

- **Conservative cold start.** Only sessions **active within ~48h**
  (`uiWindowSeconds`, configurable; default 48h) surface as live panels on
  startup. Currently-live sessions (owning process alive) always surface
  regardless of age.
- **Title gate.** Never surface a panel that is **old AND title-less**
  (still on a UUID placeholder). Recent (in-window) placeholder-titled
  sessions may show — they title quickly.
- **Background indexing.** Sessions older than the window are indexed in
  the **background at a throttled pace** once the process has spun up —
  into the persistent `session_summary`/history so project widgets and
  "what have we done here" lists are complete — **without** creating live
  panels or emitting panel deltas.
- **On-demand fast-load.** If the user opens something not yet indexed
  (e.g. clicks a project-widget session), load that transcript on a
  **priority** path immediately, faster than the background pace.

## Non-goals

- Changing the live-session ingestion path (active sessions behave as today).
- Re-architecting the lifecycle (live→done→mini→removed) timings.
- Touching `defaultRoots()` multi-account discovery (that's correct; the
  fix is bounding what surfaces, not which roots are watched).

## Design

### 1. Surfacing gate (server → client snapshot/deltas)

A panel is included in the snapshot / emitted as a live panel iff:

```
isLive(panel)                              // owning process alive
  || panel.last_event_at >= now - uiWindowSeconds   // active within ~48h
```

…and is suppressed if `old && titleless` (placeholder title AND outside the
window) — a safety net so a stale UUID panel never leaks in.

Applies to BOTH paths that feed the UI:
- `monitor.hydrate()` — only restore in-window/live panels as live; older
  persisted panels remain as `session_summary` rows (widget/history data),
  not panels.
- `watcher.bootstrap()` ingestion — see (2).

Older sessions are still **queryable** (project widgets, history, on-demand
open) — they're just not live panels.

### 2. Bootstrap walk bounding

`watcher.bootstrap()`:
- **Synchronous pass:** ingest only files within `uiWindowSeconds` (these
  become live panels immediately) — bounded, fast.
- **Defer the rest:** files older than the window are enqueued for the
  background indexer (2) rather than ingested into live panels.

Keep the existing byte-offset resume semantics for genuinely-live files.

### 3. Background indexer

A throttled job kicked off **after** HTTP is ready + initial discovery
(`index.ts`, alongside `runStartupDiscovery`). It drains the deferred
older-file queue at a gentle pace (e.g. small batch per tick with a yield /
`setTimeout`, or an idle scheduler), parsing only enough per file to
populate `session_summary` (project, title-if-present, `last_event_at`,
turn/token counts) — **no panel creation, no deltas**. Stops when drained.
Pace is conservative by default (configurable) so it never competes with
live ingestion or pegs the event loop.

### 4. On-demand fast-load

Add a server path (e.g. `trpc.reopenSession({ sessionId })`) that:
- Parses the requested transcript immediately (priority over the background
  queue), creates the panel, and emits it.
- Backs the existing `openSessionFromWidget` no-op for reaped/old sessions
  (see the existing TODO in App.tsx `openSessionFromWidget`).

Client wires the project-widget session click + dock restore to this when
the session isn't already a live panel.

## Config

New prefs (with conservative defaults):
- `discovery.uiWindowSeconds` (default 172800 = 48h) — recency cutoff for
  surfacing as a live panel.
- `discovery.backgroundBatchSize` / `discovery.backgroundIntervalMs` — the
  throttle for the background indexer.

## Open questions / decisions for implementation

- Exact throttle shape for the background indexer (fixed batch+delay vs
  idle-callback). Start simple: N files / M ms.
- Whether the title gate should also hide in-window placeholder panels
  until titled (Mike: recent placeholders may show → no, in-window shows).
- How far back the background indexer goes (all history vs a bound).

## Touch points

- `server/src/watcher.ts` — bound bootstrap walk; deferred-file queue.
- `server/src/monitor.ts` — hydrate gate; kick off background indexer.
- `server/src/session.ts` / `store.ts` — surfacing filter; summary-only
  ingest for old sessions; `reopenSession`.
- `server/src/trpc.ts` — `reopenSession` procedure; snapshot filter.
- `server/src/prefs.ts` — new `discovery.*` prefs.
- `client/src/App.tsx` / `useDeltaStream.ts` — wire on-demand open.

## Related (separate) fix

Widget-restored panel can't be dismissed (reappears ~1s) — root-caused in
TODO.md; `hiddenPanels.ts` `dismiss()` uses timestamp `hiddenAt` for
`mini` panels and the `trpc.restore` round-trip un-hides it. Fix
independently; not part of this spec.
