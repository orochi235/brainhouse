# Brainhouse

Local web monitor for Claude Code sessions. Tails the JSONL transcripts that
Claude Code writes under `~/.claude/projects` (and any other roots you point
it at), renders each session as a live panel, and demotes panels through a
`live → done → mini → removed` lifecycle as they go idle.

## Requirements

- Node 20+ (see `.nvmrc`)
- npm 10+ (workspaces)

## Quick start (dev)

```sh
nvm use            # optional, picks the version in .nvmrc
npm install
npm run dev        # runs the Fastify server + Vite dev client in parallel
```

Then open <http://localhost:8766>. The Vite dev server proxies `/trpc` and
`/health` to the API on `127.0.0.1:8765`.

## Production / one-shot use

```sh
npm install
npm run build      # builds server (tsc) + client (vite) into server/dist
npm start          # node server/dist/index.js — serves the built UI on :8765
```

Open <http://localhost:8765>.

## Install as a CLI (wip)

To run `brainhouse` from anywhere on your machine, link the package after
building:

```sh
npm install
npm run build
npm link           # creates a global `brainhouse` symlink
brainhouse         # boots the server on :8765
```

`npm unlink -g brainhouse` removes it.

The link points to this repo's `bin/brainhouse.js`, which loads
`server/dist/index.js` + the built client assets — so the CLI only reflects
changes after a rebuild. Two ways to keep things current while you hack:

```sh
# one terminal: rebuilds + reruns the server on every save
npm run start:watch     # tsc -w + vite build --watch + node --watch

# or, two-terminal flavor (run the linked CLI yourself between rebuilds)
npm run build:watch     # terminal 1 — just rebuilds
brainhouse              # terminal 2 — restart with ↑/⏎ after changes land
```

`start:watch` binds port 8765 itself, so close any other `brainhouse`
instance first. (`npm run dev` is still the right thing for HMR-on-:8766
day-to-day; the watch options above are for when you specifically want the
production-shape one-port CLI in sync.)

## Richer panels via Claude Code hooks (optional)

Brainhouse can read Claude Code's hook stream to learn things the JSONL
transcript doesn't say (or says too late):

- `Stop` / `SubagentStop` → panel demotes from `live` to `done` instantly
  instead of waiting `idleSeconds` (default 60s).
- `Notification` → panel is flagged as "blocking on user input."

Install the hook dispatcher into Claude Code's settings:

```sh
brainhouse init             # writes hooks to ~/.claude/settings.json
brainhouse init --dry-run   # show what would change
brainhouse init --uninstall # remove only brainhouse's entries
```

The installer touches `~/.claude/settings.json`. Brainhouse-owned entries
are tagged `"brainhouse": true` so re-running or uninstalling never disturbs
hooks you authored yourself.

Hook events land at `~/.brainhouse/events/<session_id>.jsonl` (override with
`BRAINHOUSE_EVENTS_DIR`). The server tails that directory the same way it
tails transcripts.

## Configuration

All knobs are optional. Defaults work out of the box if you use Claude Code
with its standard `~/.claude/projects` transcript location.

### Environment variables

| Var                 | Default              | Purpose                                                   |
|---------------------|----------------------|-----------------------------------------------------------|
| `HOST`              | `127.0.0.1`          | Bind address                                              |
| `PORT`              | `8765`               | Bind port                                                 |
| `BRAINHOUSE_ROOTS`  | (auto)               | Colon-separated list of transcript dirs; overrides prefs  |
| `BRAINHOUSE_PREFS`  | (auto)               | Path to `prefs.json` (otherwise `$XDG_CONFIG_HOME/brainhouse/prefs.json` or `~/.brainhouse/prefs.json`) |
| `BRAINHOUSE_EVENTS_DIR` | `~/.brainhouse/events` | Sidecar directory the hook dispatcher writes to and the server tails |

### Default transcript root

If neither `BRAINHOUSE_ROOTS` nor `prefs.json` specifies roots, Brainhouse
watches `~/.claude/projects`. Add more under **Accounts** in the prefs
modal if you keep transcripts elsewhere (e.g. a separate Claude config
root per workspace).

### Preferences file

Persisted at `~/.brainhouse/prefs.json` (or under `$XDG_CONFIG_HOME`).
Editable in-app via the prefs modal — schema in `server/src/prefs.ts`.

## Customization

### Per-project panel theming via [hued](https://github.com/orochi235/hued)

Drop a `.hued` file at the root of any project you work in and Brainhouse will
recolor that project's panels to match. The file is a one-liner:

```ini
# .hued
background=#320053
```

## Useful scripts

| Command            | What it does                                       |
|--------------------|----------------------------------------------------|
| `npm run dev`      | Server + client dev with HMR                       |
| `npm run build`    | Build server then client                           |
| `npm start`        | Run the built server (serves UI + API on one port) |
| `npm test`         | Vitest, both workspaces                            |
| `npm run ladle -w client`     | Component browser (Ladle) for visual states        |
| `npm run check`    | Biome lint/format check                            |
| `npm run fix`      | Biome auto-fix                                     |

## Layout

```
client/                       Vite + React 19 UI (Vitest)
  src/App.tsx                 grid + dock orchestration
  src/components/             PanelCard, PrefsModal, DebugTile, …
  src/transforms/             event → view-item pipeline (registry.ts composes the order)
  src/lib/                    hooks + utilities (prefs, layout, notifications, hued, …)
  src/useDeltaStream.ts       tRPC subscription + reducer for snapshot/delta protocol
server/                       Fastify + tRPC backend (Vitest)
  src/watcher.ts              chokidar-based JSONL tail
  src/parser.ts               raw JSONL → typed Event
  src/session.ts              Panel lifecycle, Delta protocol, DTO shaping
  src/store.ts                in-memory store + optional SQLite persistence
  src/monitor.ts              hook-event ingestion (Stop / Notification / supersede)
  src/prefs.ts                Zod-validated persisted user preferences
  src/trpc.ts                 router exposing queries / mutations / deltas subscription
docs/                         living docs — assertions, design principles, layout criteria,
                              transforms schema (read first when touching a referenced area)
hooks/                        Claude Code hook scripts the `init` command installs
bin/                          CLI entry consumed by `npm link` / `npm install -g`
scripts/, utils/              one-off dev / repro tooling
```
