# Brainhouse

Local web monitor for Claude Code sessions. Tails the JSONL transcripts that
Claude Code writes under `~/.claude/projects` (and any other roots you point
it at), renders each session as a live panel, and demotes panels through a
`live → done → mini → removed` lifecycle as they go idle.

A React+Node port of the older Python `pensieve`.

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

## Install as a CLI

To run `brainhouse` from anywhere on your machine, link the package after
building:

```sh
npm install
npm run build
npm link           # creates a global `brainhouse` symlink
brainhouse         # boots the server on :8765
```

`npm unlink -g brainhouse` removes it.

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

The installer touches `~/.claude/settings.json` and, if it exists,
`~/.claude-pw/settings.json`. Brainhouse-owned entries are tagged
`"brainhouse": true` so re-running or uninstalling never disturbs hooks you
authored yourself.

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

### Default transcript roots

If neither `BRAINHOUSE_ROOTS` nor `prefs.json` specifies roots, Brainhouse
watches:

- `~/.claude/projects`
- `~/.claude-pw/projects`

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

What you get:

- The panel's dominant message bubble (assistant in default mode, user in
  iMessage mode) is tinted with the `background` color.
- The "waiting on the model" pulse glow uses the same color, mixed against the
  base panel surface for legibility.
- Foreground text inside the tinted bubble is auto-selected (`#fff` or `#000`)
  via a YIQ contrast check, so you don't have to worry about readability.
- Near-white backgrounds (`yiq > 220`) are refused — they wash out under both
  light and dark UI themes.

Brainhouse reads `.hued` from the session's recorded `cwd`, so theming works
the moment Claude Code records a `cwd` for that panel — no extra config on
the Brainhouse side. The parser lives in `server/src/theme.ts` and is small
enough that Brainhouse re-implements it inline rather than depending on the
hued binary.

## Useful scripts

| Command            | What it does                                       |
|--------------------|----------------------------------------------------|
| `npm run dev`      | Server + client dev with HMR                       |
| `npm run build`    | Build server then client                           |
| `npm start`        | Run the built server (serves UI + API on one port) |
| `npm test`         | Vitest, both workspaces                            |
| `npm run check`    | Biome lint/format check                            |
| `npm run fix`      | Biome auto-fix                                     |

## Layout

```
client/   Vite + React 19 UI (Vitest)
server/   Fastify + tRPC backend; chokidar-based JSONL watcher (Vitest)
bin/      CLI entry consumed by `npm link` / `npm install -g`
```
