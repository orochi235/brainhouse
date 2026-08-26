# Process memory accounting: RSS columns, an idle-tree banner, and a server-loss warning

**Date:** 2026-08-26
**Status:** Approved

## Problem

Measured on this machine 2026-08-26: **86 processes and 4.89 GB RSS**
across `@playwright/mcp` and `chrome-devtools-mcp` server trees, held by
26 concurrent Claude Code sessions, the oldest nearly five days old.
System memory was exhausted at the time (~190 MB free). Nothing was
orphaned — every one of those processes traced to a live `claude`, so a
sweep keyed on dead parents finds and frees nothing.

The top widget renders all of these processes already. It cannot tell
you that they are the problem, because it does not know how much memory
anything is using: `listProcesses` invokes `ps` without `rss`, and no
row carries a memory figure.

## Goal

Make memory visible where the processes already are, and make the
reclaim gesture a click on data the user can see and judge.

## Non-goals

- **Automatic killing.** brainhouse never kills an MCP tree on its own.
  Killing a browser MCP under a session the user intends to return to
  loses whatever state it held; the user decides, every time.
- **An MCP-server classifier.** Nothing here recognizes MCP trees by
  argv. The mechanism is generic memory accounting, so it catches
  whatever the next memory hog turns out to be.
- **Capping MCP spawn at the config level.** Sessions spawning browser
  MCP servers they never use is the real cause, and fixing it belongs in
  the MCP config, not here. Tracked separately in `TODO.md`.
- **CPU.** See below.

Vocabulary: **reap** in this codebase means removing a panel from the
UI. Nothing here reaps. This feature ends processes, and calling it
reaping would collide with the panel lifecycle.

### Why not CPU

`%cpu` comes free alongside `rss` in the same `ps` call, and it is the
obvious next column — but macOS `ps -o %cpu` reports a *lifetime
average* (CPU-seconds ÷ elapsed), not current load.
A four-day-old MCP server reads `0.0` regardless of what it is doing at
that moment, and the column would never show a spike. Instantaneous CPU
requires differencing CPU-time between ticks — a separate feature, not a
column bolted onto this one.

## Architecture

Three layers, each testable on its own:

1. **Server, `processes/native.ts` + `processes/reconciler.ts`** —
   `rss_kb` becomes a field on every process row.
2. **Client, a new pure module** — subtree rollup and banner
   derivation, as functions over rows and panels.
3. **Client, `ProcessesPanel` + `ProcessRow`** — a column, a banner, a
   warning glyph.

### 1. `rss_kb` on the row

`listProcesses` invokes:

```
ps -A -o pid,ppid,lstart,rss,comm,command
```

`parsePsOutput`'s line regex gains one numeric group between the
`lstart` group and `comm`. `PsRow` and `ProcessRow` both gain
`rss_kb: number`. `Reconciler.tick` assigns it the same way it assigns
`uptime_s`.

This adds no broadcast volume. `tick` already pushes every qualifying
row into `upserts` on every 1 Hz tick, so RSS rides along on messages
that already go out each second; only the payload grows.

### 2. Rollup and banner derivation (new client module)

`ProcessesPanel` is ~700 lines. The derivation goes in its own module
with direct unit tests rather than inline. It exports:

- `subtreeRss(row, childrenByPid) → number` — sum of `rss_kb` over a row
  and its descendants.
- `reclaimable(roots, panels, thresholdSeconds, now) → { sessionIds,
  totalKb, treeCount }` — session roots whose panel has been idle past
  the threshold, with their subtree totals.

Idleness is `now - panel.last_event_at`, the same quantity `IdleCell`
already renders. A session root with **no** panel (started before
brainhouse, or otherwise unwatched) has no `last_event_at` and is
**excluded** from the total rather than assumed idle.

Summed RSS double-counts shared pages, so a Chrome tree's total is an
upper bound on its real footprint. This is stated in the column's
tooltip rather than corrected — the measurement that motivated the
feature was computed the same way, and the ranking it produces is what
the user needs.

### 3. UI

**RSS column.** Present in both views, sortable through the existing
`sortValue` switch. In sessions view, a collapsed parent shows its
subtree total; expanded, each row shows its own `rss_kb`.

**Banner.** A line in the `processes-panel` header:

```
4.9 GB in 18 trees idle >2h   [ show ]
```

Clicking filters the list to exactly those trees. The user then checks
rows and presses the existing "kill N selected". The threshold is a
select over the boundaries `IdleCell` already buckets on — 5m, 30m, 2h,
6h, 24h, 7d — defaulting to 2h. `preferences.ts` currently exposes only
`useBoolPref`; this adds a small string-valued sibling.

**Server-loss warning.** Any row that binds a listening port, or has a
port-binding descendant, gets a warning glyph beside its ✕. The
predicate is `row.ports.length > 0`: `maybeSweepPorts` already lends
descendants' ports upward with `inherited: true`, so an ancestor whose
subtree serves anything already carries it. The batch button reads
`kill 12 selected — 2 serving` when the selection contains any.

Nothing is excluded from the banner's total on these grounds. A
background `npm run dev` under an idle session counts toward the
reclaimable figure like anything else; the glyph tells the user what
they are about to take down, and they deselect it if they care.

## Testing

- `parsePsOutput` parses an `rss`-bearing line; existing fixtures
  updated.
- A reconciler tick preserves `rss_kb` onto the emitted row.
- `subtreeRss` over a nested tree.
- `reclaimable`: respects the threshold, excludes panel-less roots,
  totals across trees.
- A `ProcessRow` render test asserting the warning glyph appears for a
  row with an inherited port and not for one without.

## Open, deliberately unanswered

**Does a live Claude Code session survive losing its MCP server?**
Untested. It gated the automatic path, and there is no automatic path,
so it no longer gates anything — the user takes that risk per click.
Worth finding out before anyone proposes auto-sweeping again.
