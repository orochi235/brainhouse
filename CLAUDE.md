# brainhouse — agent pointers

Always-loaded index of where things live. When a task touches one of
these areas, read the linked file before searching.

## Terminology

Use these terms precisely — they map to specific components/concepts.

- **panel** — one session's tile in the workspace. A `parent` panel is a
  Claude Code session; a `subagent` panel is a subprocess of one. Lives in
  `client/src/components/PanelCard.tsx`; status is `live | done | mini`.
- **the grid / workspace** — the main area of full-size panels.
- **the dock / tray** — the strip of collapsed (`mini`) panels.
- **project widget** — a per-repo rollup card (stats + recent sessions),
  `client/src/components/ProjectWidgetCard.tsx`. *Fill-only*: shows only in
  grid cells no real session needs.
- **the top widget** — the `top`(1)-like live activity monitor,
  `client/src/components/ProcessesPanel.tsx` (rows in `ProcessRow.tsx`). Two
  views: **sessions** (all watched Claude Code sessions, as pstrees) and
  **network** (all processes that expose a listening port).
- **lightbox** — the full-screen overlay opened from a panel (turn/threaded
  reply/timeline views), via `lib/lightboxContext.ts`.

## Planning + workstream

- `TODO.md` — future-task list, sectioned by item. Append new ideas
  here rather than scattering them. Some sections are tagged `[HIGH]`.

## Living docs (under `docs/`)

- `docs/assertions.md` — declarative behavior rules. Append a new rule
  here alongside the change that implements it.
- `docs/design-principles.md` — UI/UX north stars (e.g. "design for
  programmers, expose primitives").
- `docs/layout-criteria.md` — the 5 design pressures panel placement
  must balance.
- `docs/transforms-schema.md` — design spec for the state/view
  transform system.
- `docs/claude-code-agents.md` — notes on the built-in Claude Code
  subagent set.

## Code orientation

- View pipeline lives in `client/src/transforms/builtIn/`; the
  composed list + execution order is `client/src/transforms/registry.ts`.
  When adding new event-shaping logic, write a transform there rather
  than scattering conditionals.
- Event parsing: `server/src/parser.ts` turns raw JSONL records into
  typed `Event`s.
- Panel lifecycle + delta protocol: `server/src/session.ts`,
  `server/src/store.ts`, client side in `client/src/useDeltaStream.ts`.
