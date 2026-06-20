# scan-transforms — design

A tool that walks recent Claude Code logs, confirms our existing selectors
still fire against real events (regression watch), surfaces event shapes no
selector handles yet (discovery), and accumulates per-selector version
metadata into a sidecar database. Goal: keep the selector schema from
silently rotting across Claude Code versions, and gather data on new patterns
worth building transforms for.

## Background — what already exists

- **`client/src/transforms/selectors/registry.ts` → `SELECTOR_REGISTRY`** is
  the de-facto schema: a named catalog of pattern guards
  (`tool-use.todo-write`, `tool-use.task-create`, `assistant-text.any`, …),
  each `{ key, name, description, selector, samplePayload }`. Today it is
  hand-authored and aspirational — `samplePayload` points at hardcoded
  fixtures, never at real log data.
- **`client/src/transforms/selectors/{parse,compile}.ts`** is a pure-TS
  selector engine: it turns a string like `event[kind=tool_use][name=TodoWrite]`
  into a closure that tests an `Event`. No React deps — portable into a script.
- **`server/src/parser.ts` → `parseLine(raw, ctx)`** turns a raw JSONL record
  into typed `Event[]`.
- **`client/src/components/transforms-inspector/inference.ts` → `infer(e)`**
  drafts a selector string from an event's shape (used by the authoring path).
- The **Pipeline inspector** modal (`TransformsModal`) is 100% derived from
  code; user-authored selectors are in-memory only. **Nothing today connects
  the registry to real logs, and there is no version/liveness metadata at
  all.** That gap is what this tool fills.

Claude Code log records carry a per-record `version` string (e.g. `2.1.112`),
which makes "last seen in Claude version X" concretely measurable.

## Design decisions (locked during brainstorming)

1. **Sidecar database, not inline metadata.** Version/liveness data lives in a
   new `observed.json`, not in `registry.ts`. The registry stays purely
   declarative; the tool only ever writes JSON. (Rejected: mutating each
   `SelectorDef` in the TS source on every run.)
2. **Thin skill over a fat deterministic script.** All regression tallying and
   discovery clustering is mechanical Node — no LLM in the hot path. The skill
   runs the script and summarizes; LLM reasoning about candidates is opt-in,
   invoked by the user afterward. (Rejected: LLM-in-every-run discovery.)
3. **Data-gathering only for now.** We accumulate the data and decide how to
   consume it (UI surfacing, alerts, etc.) later. No consumer is built yet.

## Components

### 1. The script — `scripts/scan-transforms.mts`

Deterministic, no LLM. Pipeline:

1. **Walk logs.** Default root `~/.claude/projects/**/*.jsonl` (overridable via
   flag/env). `--since <days>` window by file mtime (default 14); `--all` for
   full history.
2. **Parse.** `parseLine` each record → `Event[]`, carrying the record's
   `version` through to each event produced from it.
3. **Compile selectors once.** Reuse `parse` + `compile` over every
   `SELECTOR_REGISTRY` entry.
4. **Match + tally.** For each event, test against all compiled selectors.
   Per selector: increment a window count and track the **max `version`** seen
   to match it. Events matching **zero** selectors go to the discovery bucket.
5. **Cluster discovery (mechanical).** Bucket unmatched events by a coarse
   shape key: `kind` + tool `name` (if any) + sorted top-level payload keys +
   any `<tag>` markers found in text. Each cluster records its count, a sample
   event, and a draft selector string via `infer()`.
6. **Write outputs** (below), then print a one-screen summary.

### 2. The committed database — `client/src/transforms/selectors/observed.json`

Keyed by selector `key`. One entry:

```json
{
  "tool-use.todo-write": {
    "firstSeenVersion": "2.0.40",
    "lastSeenVersion": "2.1.112",
    "lastWindowCount": 318,
    "lastScanAt": "2026-06-20T00:00:00Z"
  }
}
```

Merge semantics across runs:

- `firstSeenVersion` = segment-wise numeric **min** of (existing, this run).
- `lastSeenVersion` = segment-wise numeric **max** of (existing, this run).
  **Cumulative** — survives log pruning, so a version observed once is never
  forgotten.
- `lastWindowCount` = recomputed **fresh** each run over the current window.
  Reflects current activity; never double-counts across runs.
- `lastScanAt` = scan timestamp (passed in, not read from a clock inside pure
  logic, to keep the core testable).

**Regression signal:** a selector whose `lastSeenVersion` stops advancing while
Claude Code's version climbs has gone stale — its trigger marker likely
changed. A selector absent from the current window entirely is reported as a
stale candidate.

### 3. Discovery output — `scripts/.scan-out/unmatched-candidates.json`

**Not committed** (gitignored). Transient triage fodder: the raw clusters with
counts, sample events, and draft selectors. This is what the LLM reads when the
user asks it to reason about new-transform candidates — it is not part of the
schema.

### 4. The skill — `scan-transforms`

Thin wrapper. Runs the script, then reports three things:

- **Confirmed live** — selectors that matched in this window.
- **Stale candidates** — registry selectors not seen in the window, or whose
  `lastSeenVersion` lags the max Claude version observed in the logs.
- **Top unmatched clusters** — the largest discovery buckets, with their draft
  selectors.

It stops there. Reasoning about whether a cluster deserves a real transform is
an explicit follow-up the user requests; the skill does not auto-propose code.

## Data flow

```
~/.claude/projects/**/*.jsonl
        │  parseLine (server/src/parser.ts)
        ▼
   Event[] (+ version per event)
        │  test against compiled SELECTOR_REGISTRY (parse+compile)
        ├── matched ──► per-selector tally + max version ──► merge ──► observed.json (committed)
        └── unmatched ─► cluster by shape key + infer() ─────────────► .scan-out/unmatched-candidates.json (transient)
```

## Error handling

- Malformed JSONL lines: skipped, counted, surfaced in the summary (do not
  abort the scan).
- Records missing `version`: matched normally; contribute to counts but not to
  version bounds.
- Missing log root: clear error naming the resolved path.
- A selector that fails to compile: reported loudly and skipped; the scan
  continues for the rest (a broken registry entry must not blind the whole run).

## Testing

- **Unit (pure core):** version-merge math, segment-wise version compare,
  cluster shape-keying, window counting — driven by fixture JSONL. The pure
  functions take an injected timestamp so they are deterministic.
- **Drift-guard test** (mirrors `transforms-inspector/sources.test.ts`): every
  `SELECTOR_REGISTRY` key has an `observed.json` entry and vice-versa, so the
  sidecar cannot silently desync from the registry. (Initial `observed.json`
  is seeded with an entry per current selector so the guard passes from day
  one.)

## Implementation notes / open items for planning

- **Cross-workspace runner.** The script imports the parser (`server/`) and the
  selector engine (`client/`). No `tsx` is installed today. Plan: add `tsx` as
  a root devDep and resolve the `@server/*` path alias via tsconfig paths;
  expose as an `npm run scan:transforms` script. Confirm the selector engine
  imports cleanly outside Vite (it uses `.ts` import specifiers and pulls in
  `__fixtures__/events.ts` — verify no `?raw` or React leaks on that path).
- **Version compare** must be segment-wise numeric, not string compare
  (`2.1.112` vs `2.1.9`).
- `.scan-out/` added to `.gitignore`.

## Out of scope (YAGNI)

- Surfacing `observed.json` anywhere in the UI / Pipeline inspector.
- Any alerting or CI gate on staleness.
- LLM-authored transform candidates committed automatically.
- Inline metadata in `registry.ts`.
