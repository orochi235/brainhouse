# Handoff — cold-start bounded discovery + project-widget dismiss bug

_2026-06-16. Pick this up in a fresh session; context was deep when written._

## Repo state

- Branch `main`, pushed through `dc087c9`/`f3c0c3e` (salient-command work +
  prod-build typecheck repair). `npm run build` is green; `npm run start`
  serves the built client on **:8765**.
- **Uncommitted when this was written:** `TODO.md` (new "Cold-start +
  lifecycle work" section), the cold-start spec, and this handoff. Commit
  them before/with the work below.
- Tests: client 511 green, server 317 green. `tsc -b` clean.

## Two workstreams

### A. Cold-start bounded discovery (the feature) — DESIGN DONE, NOT BUILT

Full design: `docs/superpowers/specs/2026-06-16-cold-start-bounded-discovery-design.md`.

One-paragraph why: first prod run surfaced ~600 placeholder-titled panels.
Cause = `monitor.hydrate()` restores every persisted panel into the
snapshot + `watcher.bootstrap()` ingests everything in a 30-min mtime
window across the now-multi-account roots (`.claude`/`.claude-pw`/
`.claude-msb`), all surfacing immediately (auto-title is async).

Agreed policy (Mike): only sessions **live or active within ~48h** become
panels; older sessions are **indexed in the background at a throttled pace
after spin-up** (into `session_summary`, no panels/deltas); **on-demand
fast-load** when the user opens one not yet indexed; never surface an
**old + title-less** panel.

Implementation shape + touch points are in the spec (§Design, §Touch
points). This is multi-file server work (`watcher`/`monitor`/`session`/
`store`/`trpc` + `prefs` + a little client wiring) → run it through
`writing-plans` → `executing-plans`. Suggested order: (1) surfacing gate in
the snapshot/hydrate path, (2) bound the bootstrap walk + deferred queue,
(3) throttled background indexer, (4) `reopenSession` on-demand path + wire
the client.

### B. Project-widget dismiss bug — ROOT-CAUSED (corrected), NOT FIXED

**Symptom:** click a project in the sidebar → it promotes into the grid →
can't dismiss it; reappears ~1s later.

**Corrected diagnosis** (a prior sub-agent got this wrong — see TODO note):
- `forceStatus(id,'done')` (`server/src/session.ts:490`) does NOT bump
  `last_event_at` (only for `'live'`), so the restore round-trip is not the
  cause.
- `hiddenPanels.test.tsx:52` proves the `hiddenAt` resurrection-on-activity
  (`isHidden` = `last_event_at <= hiddenAt`) is **intentional + tested** —
  do NOT change the shared rule.
- Real cause: the sidebar project chip's `onPromote` **pins** the
  `project:<repo>` widget (`App.tsx`, dock chip → `togglePin`). The grid
  card `onClose` calls `dismiss({status:'mini', last_event_at:
  widget.last_event_at})` → `hiddenAt[widgetId]=now`, but (a) does **not
  unpin**, and (b) the widget aggregates an **active** project, so
  `buildProjectRollups` recomputes `widget.last_event_at ≈ now` each render
  → the (intended) resurrection fires → widget returns (~1s, via the
  idle-deferred `stablePanels` recompute). Idle projects dismiss fine.

**Recommended fix (verify live; App widget wiring has no unit test):**
give WIDGET dismissal **sticky** semantics distinct from panel
resurrection — e.g. a dedicated sticky "hidden widgets" set in `App.tsx`
(or freeze the compare threshold for widget ids), AND **unpin on close**.
Do NOT make the shared `isHidden` sticky (regresses `hiddenPanels.test.tsx:52`).

**Verify:** `npm run dev`, open :8766, click a project chip whose project
is currently active → it grids → close it → confirm it stays gone.

## C. Subagent-status test-case flag — NEEDS MIKE'S TIMESTAMP

TODO records that this 2026-06-16 session is a good repro for misbehaving
subagent status tracking, but the **exact session-id + record `ts`** still
needs pinning from Mike to be a real fixture. Relates to the
[FIXED f8dc933] process-aware liveness work.

## How to run / verify

```bash
npm run build && npm run start     # prod → http://localhost:8765
# or
npm run dev                        # client :8766, server :8765
```
Mind the port clash with any running dev server (`PORT=… npm run start`).
