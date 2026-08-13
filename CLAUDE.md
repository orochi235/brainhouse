# brainhouse — agent pointers

Always-loaded index of where things live. When a task touches one of
these areas, read the linked file before searching.

## Single-user project — deploy immediately

This project has exactly one user: its author, running the production
service on this machine. There is no other tester, so a change that
isn't deployed is a change nobody is exercising. The service normally
runs in watch mode (`scripts/watch-service.mjs`, installed by
`npm run service:install`): server/client source edits rebuild and
redeploy themselves within a few seconds — client edits reload open
browser tabs, server edits restart the server child. Verify a change
landed via `~/Library/Logs/brainhouse/stdout.log` (`[watch-service]`
lines) rather than kickstarting. Manual `npm run build` +
`launchctl kickstart -k gui/$(id -u)/com.brainhouse` is the fallback
(and the only path when installed with WATCH=0). After touching
`menubar/` or its install script, rerun `npm run menubar:install`;
after touching `hooks/`, remember running Claude Code sessions keep
their hook snapshot — only new sessions pick changes up. Leaving work
built-but-not-deployed (or worse, uncommitted) means it silently rots
untested.

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
