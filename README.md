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

### Default transcript roots

If neither `BRAINHOUSE_ROOTS` nor `prefs.json` specifies roots, Brainhouse
watches:

- `~/.claude/projects`
- `~/.claude-pw/projects`

### Preferences file

Persisted at `~/.brainhouse/prefs.json` (or under `$XDG_CONFIG_HOME`).
Editable in-app via the prefs modal — schema in `server/src/prefs.ts`.

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
