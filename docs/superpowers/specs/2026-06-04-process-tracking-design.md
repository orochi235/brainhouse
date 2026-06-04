# Process tracking dashboard — design

A top-like panel in brainhouse that tracks every live OS process spawned (directly or transitively) by a Claude Code session, plus already-listening services on the host. The panel answers four questions at a glance: *what dev servers are alive right now, on which ports, started by which agent, and which one am I actually hitting when I open `localhost:3000`?*

## Goals

- Find and kill zombie dev servers left behind by completed sessions.
- Know which port each running dev server is bound to and click through to it.
- Per-session attribution: tell me which agent started a given process.
- Single dashboard view across all sessions.

## Non-goals (v1)

- Historical / dead-process forensics. Live-only retention.
- Remote-host process tracking. Local-only, but module boundary preserved for future expansion.
- Resource graphs (CPU/RSS over time). PID, command, ports, runtime is enough for v1.
- Persistence across server restarts. The table is a view of the current world.

## Architecture

```
                 ┌─────────────────────────────────────────────┐
                 │              ProcessTracker                 │
                 │  server/src/processes/                      │
                 │                                             │
  hooks ─────────▶  session-pid registry   bash-intent buffer  │
                 │           │                    │            │
                 │           ▼                    ▼            │
  ps ────────────▶     tree walker  ──── reconciler ──┐        │
  lsof ──────────▶     port sweeper ──────────────────┤        │
  kqueue NOTE_EXIT ──▶ death watcher ────────────────┤        │
                 │                                    │        │
                 │                                    ▼        │
                 │                             processes table │
                 │                                    │        │
                 │                                    ▼        │
                 │                        delta stream → UI    │
                 └─────────────────────────────────────────────┘
```

All host-specific bits (`ps`, `lsof`, `kqueue`, `proc_pidpath`, version-manager regexes) are isolated in `server/src/processes/native.ts` behind a single interface. A future remote-host sidecar substitutes that file; reconciler, schema, delta protocol, and UI stay unchanged.

## Data model

In-memory `processes` table; rebuilt on server boot.

| Field | Type | Notes |
|---|---|---|
| `process_id` | text PK | `p_<host>_<pid>_<start_ns>`, stable across reconnects |
| `host` | text | `'local'` for v1 |
| `pid` | int | |
| `ppid` | int | |
| `start_ts` | int (ns) | from `ps`; part of identity (PIDs recycle) |
| `command` | text | full argv joined; from `ps` |
| `cwd` | text | from `ps` (`lsof -p PID -d cwd`) |
| `session_id` | text? | attributed Claude session, if any |
| `hook_command` | text? | agent's verbatim Bash `input.command` |
| `run_in_background` | int | 0/1, from hook |
| `provenance` | text | `hooked` \| `observed` \| `discovered` \| `heuristic` |
| `runtime` | text? | `node` \| `python` \| `ruby` \| `bun` \| `deno` \| `go` \| `cargo` \| `php` \| … |
| `runtime_version` | text? | e.g. `22.5.0` |
| `runtime_source` | text? | `path` \| `probe` \| `unknown` |
| `framework` | text? | `vite` \| `next` \| `webpack-dev-server` \| `astro` \| `remix` \| `nuxt` \| `rails` \| `django` \| … |
| `framework_version` | text? | from sibling `package.json` when path leaks it, else probe |
| `ports` | JSON | `[{port, proto, addr}]`, updated by lsof sweep |
| `ended_ts` | int? | when set, row purges after grace period |
| `ended_reason` | text? | `exit` \| `signaled` \| `killed_by_user` \| `lost` |

Identity is `(host, pid, start_ts)`. A recycled PID is a new row.

### Provenance tiers (highest fidelity first)

1. `hooked` — observed in the process tree **and** matched to a PreToolUse Bash record. Highest confidence; we know the agent's intent string and `run_in_background` flag.
2. `observed` — in the process tree of a known session PID, no matching hook record.
3. `heuristic` — not in any session's tree, but `cwd` matches a known session's `cwd`. Used as a fallback when SessionStart hook didn't fire.
4. `discovered` — found by startup `lsof` sweep; no session attribution.

UI dot colors: 🟢 hooked, 🟡 observed, 🟠 heuristic, ⚪ discovered.

## Capture pipeline

### 1. Session-PID registry

A `SessionStart` hook writes a side-channel record:

```json
{"kind": "session_pid", "session_id": "...", "pid": 12345, "ppid": 12300, "cwd": "...", "start_ts": 1733260800123456789}
```

The server maintains a `session_pids` map keyed by `session_id`. Without this, descendants can't be attributed.

### 2. Bash-intent labeller

`PreToolUse` hook on `Bash`. Writes:

```json
{"kind": "bash_intent", "session_id": "...", "ts": ..., "command": "...", "run_in_background": true, "cwd": "..."}
```

Kept in a rolling per-session buffer (last 50 entries, ~30s TTL). Pure labelling — never creates `processes` rows on its own.

A `PostToolUse` hook records `{tool_use_id, bash_id}` for `run_in_background=true` calls so the server can later request a stdout tail via the existing BashOutput facility.

### 3. Tree walker

Every 1s: `ps -A -o pid,ppid,lstart,comm,command` (and `lsof -p <pid> -d cwd -Fn` for cwd, batched). For each registered session root PID, compute the descendant set.

- **New PIDs** → INSERT with `provenance='observed'`, then enrich:
  - match against rolling Bash buffer for the same `session_id` within ±2s of `start_ts` → fill `hook_command`, `run_in_background`, promote provenance to `hooked`
  - detect runtime / framework (see below)
  - register PID with kqueue `NOTE_EXIT`
- **Missing PIDs** (in table, not in `ps`) → require **two consecutive missed ticks** before finalizing with `ended_reason='lost'`. Prevents false deaths on transient `ps` hiccups.
- **PID present but `start_ts` differs** → PID recycled; finalize old row as `lost`, insert new row.

### 4. Port sweeper

Every 5s **while at least one client has the dashboard panel open**: `lsof -nP -iTCP -sTCP:LISTEN -F pPn`. Update `ports` JSON on matching rows. Throttles to zero when nobody is watching — lsof is the expensive piece.

Port updates emit a `process_ports` delta (separate event from `process_upsert`) to avoid full-row churn every tick.

### 5. Startup sweep

On server boot: one `lsof` pass to seed `processes` rows with `provenance='discovered'` for already-listening ports. `session_id` stays NULL.

### 6. Death paths

- kqueue `NOTE_EXIT` fires → `ended_reason='exit'`.
- Tree walker confirms absence over 2 ticks → `ended_reason='lost'` (kqueue race or non-child death).
- User clicks kill → `signaled` → `killed_by_user` after confirmed gone.

After `ended_ts`, the row is held for a short grace period (long enough for the `process_delete` delta to reach clients) then dropped.

### Runtime detection (cheap → expensive)

1. **Path inspection.** Regex the executable path for version-manager patterns: `~/.nvm/versions/node/v22.5.0/bin/node`, `~/.asdf/installs/python/3.12.4/bin/python`, `~/.rbenv/versions/3.3.0/bin/ruby`, Volta, mise, pyenv. `runtime_source='path'`. No exec.
2. **Probe.** `<exe> --version`, cached forever keyed by `(path, mtime, size)`. One subprocess per distinct interpreter binary across the server's lifetime. `runtime_source='probe'`. Constraints:
   - 2s timeout
   - `stdin=/dev/null`
   - empty env except `PATH`
   - only against executables under known prefixes: `/usr/bin`, `/usr/local`, `/opt/homebrew`, `~/.nvm`, `~/.asdf`, `~/.rbenv`, `~/.local`, `/Applications`. Anything else → `runtime_source='unknown'`, no exec.
3. **Argv heuristic.** `python3.12 -m http.server` → runtime=python, version=`3.12` minor-only.

### Framework detection

Argv scan first: `node …/node_modules/vite/bin/vite.js` → framework=`vite`. Version from the sibling `package.json` (read once, cached). No exec needed for the common case.

## Delta protocol

Extend `useDeltaStream`:

```
process_upsert  { process_id, …all fields }
process_delete  { process_id }
process_ports   { process_id, ports }
```

Server tracks per-client subscription so the port sweeper knows when to idle.

## UI

New `processes` panel kind, registered alongside existing kinds (peer of `ProjectWidgetCard`). Created once, persists in the grid. A `+` affordance creates it if absent.

### Layout

Single dense table, sortable. Default sort: uptime desc.

```
●  PID   runtime · ver   framework · ver   :ports        cwd               session     uptime   actions
🟢 4823  node 22.5.0     vite 5.4.2        :5173 :24678  brainhouse        client-dev  12m 04s  [⎘] [↗] [▾] [✕]
🟢 4901  python 3.12.4   django 5.1.1      :8000        api-svc            backend     03m 21s  [⎘] [↗] [▾] [✕]
🟡 5102  node 22.5.0     —                 —           experiments         scratch     00m 41s          [↗] [▾] [✕]
⚪ 1023  postgres 16     —                 :5432        —                  (discovered) 9h 12m  [⎘]      [✕]
```

- `●` = provenance tier.
- `:ports` clickable → opens `http://localhost:<port>` **only when** the listening address is loopback (`127.0.0.1`, `::1`) or `0.0.0.0`. Non-loopback binds show the port without a link (ambiguous hostname).
- `session` shows the session's title; click focuses that panel via existing focus action.
- `▾ tail` opens inline expansion with last ~40 lines of stdout/stderr. **Only available** when `run_in_background=1` (otherwise Claude Code retains no buffer we can pull). Hidden, not disabled, otherwise.
- `✕ kill` confirms inline → SIGTERM → 3s grace → SIGKILL. Row stays until death is observed.

### Filter & empty state

- Single substring filter across command / cwd / session / framework.
- Empty state: *"No processes observed yet. Brainhouse watches descendants of each Claude session and listening ports on this host."*

### Signal-strong filter

Tree walker tracks every descendant internally for correlation, but only broadcasts rows where **any** of: `run_in_background=1`, uptime ≥ 3s, or at least one listening port. Sub-3s foreground commands (`grep`, `cat`, `git`) never reach the UI. Threshold in config.

## Error handling & edge cases

- **PID recycling** — disambiguated by `start_ts`; old row finalized as `lost`, new row inserted.
- **SessionStart hook missing** — no session root PID; tree walker can't attribute. `cwd`-match fallback produces `provenance='heuristic'` rows (🟠).
- **Hook buffer overflow** — last 50 entries / ~30s TTL per session. Older drops just degrade `hooked` → `observed`.
- **`ps` / `lsof` failure** — log + skip the tick. Two-tick absence rule prevents false deaths.
- **kqueue setup race** — registration failure (PID already gone, EBADF) is not retried; tree walker is the safety net.
- **Server restart** — in-memory state rebuilt from startup sweep + fresh tree walk. `processes` is not persisted.

## Security

- **Local only**, no network auth — brainhouse server already runs as the user.
- **Kill button** — server refuses to signal PIDs not in its `processes` table and refuses PIDs ≤ 1000 (system).
- **Open-URL** — loopback / `0.0.0.0` binds only get clickable links.
- **Runtime probe** — sandboxed exec (2s timeout, `stdin=/dev/null`, minimal env, allowlisted exec prefixes).

## Module layout

```
server/src/processes/
  index.ts          ProcessTracker public interface: subscribe, kill, getLive
  reconciler.ts     merges signals, owns the table
  tree.ts           tree-walk producer
  ports.ts          lsof producer (subscriber-gated)
  death.ts          kqueue / 2-tick-absence producer
  runtime.ts        path-regex + probe + argv-heuristic detection (cached)
  framework.ts      argv-scan + package.json sniffing
  native.ts         host-specific shell-outs (ps, lsof, proc_pidpath, kqueue)
hooks/
  session-start.mjs    writes session_pid record
  pre-tool-use.mjs     writes bash_intent record
  post-tool-use.mjs    writes bash_id mapping (run_in_background only)
client/src/components/
  ProcessesPanel.tsx   the dashboard panel
  ProcessRow.tsx       table row
client/src/transforms/builtIn/
  processes.ts         hooks delta stream into a UseProcesses() store
```

## Open questions for implementation

None blocking; the following are deferred to implementation judgment:

- Exact grace-period duration between `ended_ts` and row drop.
- Whether to show a per-row sparkline of historical port presence (currently no — out of scope for live-only).
- Whether to add a config knob for the 3s "signal-strong" threshold or hard-code it.

## Future: remote hosts (out of scope for v1)

Everything in `server/src/processes/native.ts` becomes the interface a `brainhouse-procd` sidecar implements on remote hosts, with a unix-socket / TCP transport. The reconciler treats remote-host rows identically; `host` field disambiguates IDs. No schema or UI change required.
