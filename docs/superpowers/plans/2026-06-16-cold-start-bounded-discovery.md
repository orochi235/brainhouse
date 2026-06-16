# Cold-Start Bounded Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the first prod run from dumping ~600 placeholder panels by surfacing only recently-active (or live) sessions as panels, indexing older sessions into `session_summary` in a throttled background pass, and fast-loading any older session on demand.

**Architecture:** A server-side recency/title *surfacing gate* in `SessionStore.snapshot()` bounds what the client ever sees. `watcher.bootstrap()` is re-bounded to the UI window and *collects* older-but-recent files into a deferred queue instead of ingesting them. A new throttled `BackgroundIndexer` drains that queue into `session_summary` (no panels, no deltas) using a throwaway `SessionStore`. A `reopenSession` tRPC mutation parses a single transcript on demand and feeds it through the normal `apply()` path so it appears live. All tunables live under a new `discovery.*` prefs group.

**Tech Stack:** TypeScript (server: Fastify + tRPC + better-sqlite3; client: React + tRPC subscription), Vitest, Zod.

**Source spec:** `docs/superpowers/specs/2026-06-16-cold-start-bounded-discovery-design.md`. Decisions locked with Mike: background index is **bounded to ~90 days** (configurable); `reopenSession` **is in scope** for this plan.

---

## File Structure

**New files:**
- `server/src/indexer.ts` — `BackgroundIndexer` class: throttled drain of the deferred-file queue into `session_summary`. One responsibility: offline summarization pacing.
- `server/src/indexer.test.ts` — indexer unit tests.

**Modified files:**
- `server/src/prefs.ts` — add `DiscoverySchema` + `discovery` group.
- `server/src/session.ts` — surfacing gate in `snapshot()`; `uiWindowSeconds` option; new public `summarizeOffline()`; export `buildSessionSummary` (currently module-private).
- `server/src/store.ts` — add `getSessionSummary(id)` single-row lookup.
- `server/src/watcher.ts` — bootstrap bounded to UI window + deferred-file collection; `takeDeferredFiles()`; `parseFile()`.
- `server/src/monitor.ts` — pass `uiWindowSeconds` to `SessionStore`; kick off `BackgroundIndexer` after watch starts; `reopenSession()`.
- `server/src/trpc.ts` — `reopenSession` mutation.
- `client/src/App.tsx` — wire `openSessionFromWidget` to `trpc.reopenSession`.
- existing test files for `session`/`watcher`/`prefs` as noted per task.

**Key existing anchors (from code survey):**
- `SessionStore.snapshot()` — `server/src/session.ts:598-605` (the single chokepoint feeding both the `snapshot` query and the subscription hello).
- `SessionStore.apply()` — `server/src/session.ts:285-373`; `ensurePanel()` `663-710`; `forceStatus()` `490-499`.
- `buildSessionSummary()` — `server/src/session.ts:1322-1376` (module-private; this plan exports it).
- `initialTitle()` — `server/src/session.ts:1172-1184` (placeholder detector).
- `encodeCwdToProjectDir()` — exported, `server/src/session.ts:1151`.
- `Store.materializeSession(row)` — `server/src/store.ts:539-594`; `SessionSummaryRow` `128-166`; schema `231-253`.
- `watcher.bootstrap()` — `server/src/watcher.ts:145-195`; `parseLine` imported from `./parser.js` (`watcher.ts:20`); `classifyPath` exported `38-57`; `walk()` private `328-340`; `tailJsonl()` `287-326`.
- `monitor.startWatching()` — calls `watcher.start({watch:true})` then lifecycle loops (`server/src/monitor.ts:183-194`); `hydrate()` `155-174`; `ingest()` `449-466`.
- trpc router `server/src/trpc.ts:65-447`; `snapshot` query `:68`; `deltas` subscription `:438-446`; `restore`/`remove` mutation pattern `:84-95`; ctx has `{ monitor, prefs, store, tracker }`.
- prefs `WorkspaceSchema` template `server/src/prefs.ts:93-124`; `PrefsSchema` `235-249`; `DEFAULT_PREFS` `252`.
- Client `openSessionFromWidget` — `client/src/App.tsx:651-679` (TODO at `657-659`); delta reducer `useDeltaStream.ts:66-131`.

**Conventions:** server uses Vitest; tests live beside source as `*.test.ts`. Run a single file with `npm run test -w server -- src/<file>.test.ts`. Lint/format: `npx biome check --write <files>`. Commit per task.

---

### Task 1: Add `discovery.*` prefs group

**Files:**
- Modify: `server/src/prefs.ts` (schema after the `Debug` group ~line 220; `PrefsSchema` ~line 242)
- Test: `server/src/prefs.test.ts` (or create if absent)

- [ ] **Step 1: Write the failing test**

Append to `server/src/prefs.test.ts` (create the file with the imports if it does not exist):

```typescript
import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFS, PrefsSchema } from './prefs.js';

describe('discovery prefs', () => {
  it('has conservative defaults', () => {
    expect(DEFAULT_PREFS.discovery).toEqual({
      uiWindowSeconds: 172800, // 48h
      backgroundMaxAgeSeconds: 7776000, // 90d
      backgroundBatchSize: 25,
      backgroundIntervalMs: 4000,
    });
  });

  it('fills discovery defaults when the group is omitted', () => {
    const parsed = PrefsSchema.parse({});
    expect(parsed.discovery.uiWindowSeconds).toBe(172800);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w server -- src/prefs.test.ts`
Expected: FAIL — `discovery` is undefined / not a key of `DEFAULT_PREFS`.

- [ ] **Step 3: Add the schema and wire it in**

In `server/src/prefs.ts`, after the `Debug` schema/type block (~line 220), add:

```typescript
export const DiscoverySchema = z.object({
  /** Recency cutoff (seconds) for surfacing a session as a live panel on
   * cold start. Sessions whose owning process is alive always surface
   * regardless of age; otherwise last_event_at must be within this window. */
  uiWindowSeconds: z.number().int().positive().default(172800), // 48h
  /** How far back (seconds) the throttled background indexer reaches when
   * filling session_summary. Files older than this are ignored entirely
   * until opened on demand. */
  backgroundMaxAgeSeconds: z.number().int().positive().default(7776000), // 90d
  /** Files summarized per background tick. */
  backgroundBatchSize: z.number().int().positive().default(25),
  /** Delay between background ticks (ms). */
  backgroundIntervalMs: z.number().int().positive().default(4000),
});
export type Discovery = z.infer<typeof DiscoverySchema>;
```

Then add to `PrefsSchema` (the `z.object({...})` at ~line 242), alongside `workspace`:

```typescript
  discovery: DiscoverySchema.default(DiscoverySchema.parse({})),
```

(`DEFAULT_PREFS` at line 252 is `PrefsSchema.parse({})`, so it picks the group up automatically — no second edit.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w server -- src/prefs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/prefs.ts server/src/prefs.test.ts
git commit -m "feat(server): add discovery.* prefs (ui window + background index throttle)"
```

---

### Task 2: Surfacing gate in `SessionStore.snapshot()`

The snapshot is the single chokepoint for both the initial `snapshot` query and the subscription's hello frame. Gating here bounds everything the client sees from hydrated panels, without deleting them from memory (they stay queryable and keep their lifecycle/summary behavior).

**Files:**
- Modify: `server/src/session.ts` — `SessionStore` constructor options + `snapshot()` (598-605)
- Test: `server/src/session.test.ts` (append; file exists)

- [ ] **Step 1: Write the failing test**

Append to `server/src/session.test.ts`. (Match the existing helpers in that file for building events/stores; the snippet below assumes the existing `SessionStore` constructor options object. If the file already has a `makeStore`/event helper, reuse it and adapt the field names.)

```typescript
import { describe, expect, it } from 'vitest';
import { SessionStore } from './session.js';

// Minimal parent text event factory (align field names with parser Event).
function textEvent(sessionId: string, ts: string, text = 'hi') {
  return {
    session_id: sessionId,
    agent_id: null,
    uuid: `${sessionId}:${ts}`,
    parent_uuid: null,
    ts,
    cwd: '/tmp/proj',
    kind: 'user_text' as const,
    tags: [],
    payload: { text },
  };
}

describe('snapshot surfacing gate', () => {
  it('omits an old, titleless panel but keeps a recent one', () => {
    const now = 1_000_000;
    const store = new SessionStore({
      clock: () => now,
      isSessionLive: () => false,
      uiWindowSeconds: 100,
    });
    // Recent session (last_event_at within window) — titleless is OK.
    store.apply(textEvent('recent', new Date((now - 10) * 1000).toISOString()));
    // Old session (outside window), still titleless → suppressed.
    store.apply(textEvent('old', new Date((now - 10_000) * 1000).toISOString()));

    const ids = store.snapshot().map((p) => p.id);
    expect(ids).toContain('recent');
    expect(ids).not.toContain('old');
  });

  it('always surfaces a live session even if old', () => {
    const now = 1_000_000;
    const store = new SessionStore({
      clock: () => now,
      isSessionLive: (id) => id === 'old',
      uiWindowSeconds: 100,
    });
    store.apply(textEvent('old', new Date((now - 10_000) * 1000).toISOString()));
    expect(store.snapshot().map((p) => p.id)).toContain('old');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w server -- src/session.test.ts`
Expected: FAIL — `uiWindowSeconds` option ignored; `old` still present in snapshot.

- [ ] **Step 3: Implement the gate**

In `SessionStore`'s options interface/constructor, accept and store `uiWindowSeconds` with a safe default:

```typescript
// in the constructor options type:
uiWindowSeconds?: number;

// in the constructor body, alongside the other option assignments:
this.uiWindowSeconds = opts.uiWindowSeconds ?? 172800;

// field declaration with the other private fields:
private uiWindowSeconds: number;
```

Replace `snapshot()` (598-605) with the gated version:

```typescript
snapshot(): Array<PanelDto & { events: Event[] }> {
  const now = this.clock();
  const cutoff = now - this.uiWindowSeconds;
  return Array.from(this.panels.values())
    .filter((p) => p.binned_at === null && this.isSurfaceable(p, now, cutoff))
    .map((p) => ({
      ...this.toDto(p),
      events: p.events.slice(),
    }));
}

/** A panel surfaces as a live UI panel iff its owning process is alive, or
 * it has been active within the UI window. As a safety net, an out-of-window
 * panel that still wears its UUID placeholder title is never surfaced (a
 * stale persisted row must not leak in). */
private isSurfaceable(p: Panel, now: number, cutoff: number): boolean {
  const owner = p.kind === 'subagent' ? (p.parent_panel_id ?? p.id) : p.id;
  if (this.isSessionLive(owner)) return true;
  const recent = p.last_event_at >= cutoff;
  if (!recent) return false;
  return true;
}
```

(The titleless safety net is implied by `recent` already excluding old rows; if you want the explicit belt-and-suspenders form, add `&& !(p.title === initialTitle(p.id, p.kind) && !recent)` — but with the recency gate it is unreachable, so the simple form above is sufficient. Keep the comment.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w server -- src/session.test.ts`
Expected: PASS. Also run the full server suite to confirm no snapshot consumers regressed:
Run: `npm run test -w server`
Expected: PASS (existing snapshot tests may need a `uiWindowSeconds` large enough; the default 172800 keeps prior fixtures surfacing as before).

- [ ] **Step 5: Commit**

```bash
git add server/src/session.ts server/src/session.test.ts
git commit -m "feat(server): surfacing gate in snapshot() — live-or-recent only"
```

---

### Task 3: Wire `uiWindowSeconds` from prefs into the monitor's store + bootstrap

**Files:**
- Modify: `server/src/monitor.ts` — `SessionStore` construction (102-122) and `TranscriptWatcher` construction; pass window from prefs.
- Modify: `server/src/index.ts` — pass `discovery` prefs into the monitor options (around the `TranscriptMonitor` construction `33-45`).

- [ ] **Step 1: Add a `uiWindowSeconds` to `MonitorOptions` and thread it**

In `server/src/monitor.ts`, add to `MonitorOptions`:

```typescript
uiWindowSeconds?: number;
```

In the `SessionStore` construction (monitor.ts:102-113), pass it through:

```typescript
this.store = new SessionStore({
  // ...existing options...
  isSessionLive: (sessionId) => this.tracker?.liveSessionIds().has(sessionId) ?? false,
  uiWindowSeconds: opts.uiWindowSeconds,
});
```

In the `TranscriptWatcher` construction, set its bootstrap window to the same value so bootstrap and the snapshot gate agree:

```typescript
this.watcher = new TranscriptWatcher(
  opts.roots,
  (event, sourceRoot) => this.ingest(event, sourceRoot),
  { store: opts.store ?? null, bootstrapAgeSeconds: opts.uiWindowSeconds ?? 172800 },
);
```

- [ ] **Step 2: Pass prefs into the monitor in `index.ts`**

In `server/src/index.ts`, where `discovery`/`workspace`/`timings` are read from `prefs.get()`, add `discovery` and pass it:

```typescript
const discovery = prefs.get().discovery;
// ...
const monitor = new TranscriptMonitor({
  // ...existing options...
  uiWindowSeconds: discovery.uiWindowSeconds,
});
```

- [ ] **Step 3: Build to typecheck**

Run: `npm run build:server`
Expected: clean tsc.

- [ ] **Step 4: Commit**

```bash
git add server/src/monitor.ts server/src/index.ts
git commit -m "feat(server): thread discovery.uiWindowSeconds into store + bootstrap window"
```

---

### Task 4: Collect deferred (older-but-recent) files during bootstrap

`bootstrap()` already walks every file and applies an mtime cutoff. Extend it: files **older than the UI window but within `backgroundMaxAgeSeconds`** are pushed to a deferred queue instead of being silently skipped. The queue is drained later by the indexer (Task 6).

**Files:**
- Modify: `server/src/watcher.ts` — `WatcherOptions`, constructor, `bootstrap()` (145-195), new `takeDeferredFiles()`.
- Test: `server/src/watcher.test.ts` (append; file exists)

- [ ] **Step 1: Write the failing test**

Append to `server/src/watcher.test.ts` (reuse the file's existing temp-root + file-writing helpers; the sketch shows intent — adapt helper names to the file):

```typescript
import { describe, expect, it } from 'vitest';
// reuse existing helpers in this test file: makeTempRoot(), writeJsonl(root, sessionId, lines), setMtime(path, secondsAgo)

describe('bootstrap deferred-file collection', () => {
  it('defers files older than the UI window but within the max-age bound', async () => {
    const root = await makeTempRoot();
    const recent = writeJsonl(root, 'recent', [/* one user_text line */]);
    const oldish = writeJsonl(root, 'oldish', [/* one user_text line */]);
    const ancient = writeJsonl(root, 'ancient', [/* one user_text line */]);
    setMtime(recent, 60); // 1m ago — in window
    setMtime(oldish, 3 * 24 * 3600); // 3d ago — deferred
    setMtime(ancient, 200 * 24 * 3600); // 200d ago — ignored

    const ingested: string[] = [];
    const w = new TranscriptWatcher(
      [root],
      (e) => ingested.push(e.session_id),
      { bootstrapAgeSeconds: 172800, deferredMaxAgeSeconds: 7776000 },
    );
    await w.bootstrap();

    expect(ingested).toContain('recent');
    expect(ingested).not.toContain('oldish');
    const deferred = w.takeDeferredFiles().map((p) => p.split('/').pop());
    expect(deferred).toEqual(['oldish.jsonl']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w server -- src/watcher.test.ts`
Expected: FAIL — `deferredMaxAgeSeconds` / `takeDeferredFiles` do not exist.

- [ ] **Step 3: Implement deferred collection**

In `WatcherOptions` (watcher.ts:64-74) add:

```typescript
  /** Parent files older than `bootstrapAgeSeconds` but with mtime within
   * this bound are collected for background summarization instead of being
   * ingested as live panels. 0/undefined disables collection. */
  deferredMaxAgeSeconds?: number;
```

In the constructor (86-92) add:

```typescript
  private readonly deferredMaxAgeSeconds: number;
  private readonly deferred: string[] = [];
  // ...in body:
  this.deferredMaxAgeSeconds = opts.deferredMaxAgeSeconds ?? 0;
```

In `bootstrap()` parent loop (159-176), replace the `if (!hasOffset && mtime < cutoff) continue;` line with a branch that defers in-range-but-old files:

```typescript
        const hasOffset = this.offsets.has(file);
        if (!hasOffset && mtime < cutoff) {
          // Older than the live window. If it is within the background
          // max-age bound, queue it for throttled summarization; otherwise
          // ignore it entirely (only reachable via on-demand reopen).
          const deferCutoff = Date.now() / 1000 - this.deferredMaxAgeSeconds;
          if (this.deferredMaxAgeSeconds > 0 && mtime >= deferCutoff) {
            this.deferred.push(file);
          }
          continue;
        }
        liveSessions.add(info.session_id);
        await this.processPath(file);
```

Add the drain accessor near `takeDeferredFiles` (after `bootstrap()`):

```typescript
  /** Hand off the files collected for background summarization, clearing the
   * internal queue. Returns parent transcript paths only (subagents are
   * summarized with their parent on the live path; the background pass is
   * parent-granular). */
  takeDeferredFiles(): string[] {
    return this.deferred.splice(0, this.deferred.length);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w server -- src/watcher.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/watcher.ts server/src/watcher.test.ts
git commit -m "feat(server): bootstrap collects deferred older-but-recent files"
```

---

### Task 5: `watcher.parseFile()` + `SessionStore.summarizeOffline()`

Two reusable primitives the indexer (Task 6) and reopen (Task 7) both need: read+parse a whole transcript into `Event[]`, and turn `Event[]` into a `SessionSummaryRow` **without** creating a live panel or emitting deltas.

**Files:**
- Modify: `server/src/watcher.ts` — add `parseFile()`.
- Modify: `server/src/session.ts` — export `buildSessionSummary`; add public `summarizeOffline()`.
- Test: `server/src/session.test.ts` (append)

- [ ] **Step 1: Add `parseFile()` to the watcher**

In `server/src/watcher.ts`, add (reusing the already-imported `parseLine` and exported `classifyPath`):

```typescript
  /** Read an entire transcript file and return its parsed events. Unlike
   * `tailJsonl`, this ignores byte offsets and never calls `onEvent` — it is
   * a pure read used by the background indexer and on-demand reopen. */
  async parseFile(absPath: string): Promise<Event[]> {
    const info = classifyPath(absPath);
    if (!info || info.is_meta) return [];
    let text: string;
    try {
      text = await readFile(absPath, 'utf8');
    } catch {
      return [];
    }
    const out: Event[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== 'object') continue;
      for (const event of parseLine(parsed as Record<string, unknown>, {
        session_id: info.session_id,
        agent_id: info.agent_id,
      })) {
        out.push(event);
      }
    }
    return out;
  }
```

- [ ] **Step 2: Export `buildSessionSummary` and add `summarizeOffline`**

In `server/src/session.ts`, change `function buildSessionSummary(` (line ~1322) to `export function buildSessionSummary(`.

Add a public method to `SessionStore` that replays events into a panel **local to this store instance** (callers use a throwaway store, see Task 6) and returns the summary row without touching persistence or deltas:

```typescript
  /** Build a session_summary row for a fully-parsed transcript without
   * surfacing it as a live panel. Intended to run on a *throwaway*
   * SessionStore (store=null) so the apply() mutations and discarded deltas
   * never reach a live subscriber. Returns null if the events produced no
   * parent panel. */
  summarizeOffline(events: Event[]): SessionSummaryRow | null {
    let sessionId: string | null = null;
    for (const event of events) {
      this.apply(event); // deltas discarded; this.store is null on throwaway
      if (!event.agent_id) sessionId = event.session_id;
    }
    if (!sessionId) return null;
    const panel = this.panels.get(sessionId);
    if (!panel) return null;
    // 'never' = we did not observe this session ending; it is being indexed
    // retroactively from a complete-on-disk transcript.
    return buildSessionSummary(panel, 'never', this.clock());
  }
```

(`SessionSummaryRow` is imported from `./store.js` in session.ts already; if not, add it to the existing store-type import.)

- [ ] **Step 3: Write the failing test**

Append to `server/src/session.test.ts`:

```typescript
import { SessionStore } from './session.js';

describe('summarizeOffline', () => {
  it('produces a summary row from events without creating a surfaced panel', () => {
    const store = new SessionStore({ clock: () => 2_000_000, isSessionLive: () => false });
    const ev = (ts: string) => ({
      session_id: 'sx', agent_id: null, uuid: `sx:${ts}`, parent_uuid: null,
      ts, cwd: '/tmp/p', kind: 'user_text' as const, tags: [], payload: { text: 'hi' },
    });
    const row = store.summarizeOffline([ev('2020-01-01T00:00:00.000Z')]);
    expect(row).not.toBeNull();
    expect(row?.session_id).toBe('sx');
    expect(row?.cwd).toBe('/tmp/p');
  });
});
```

- [ ] **Step 4: Run tests**

Run: `npm run test -w server -- src/session.test.ts`
Expected: PASS.
Run: `npm run build:server`
Expected: clean tsc (confirms the `export` + watcher additions typecheck).

- [ ] **Step 5: Commit**

```bash
git add server/src/watcher.ts server/src/session.ts server/src/session.test.ts
git commit -m "feat(server): parseFile() + summarizeOffline() primitives"
```

---

### Task 6: `BackgroundIndexer` + kickoff after watch starts

A throttled job that drains the watcher's deferred queue: per tick, take up to `backgroundBatchSize` files, `parseFile` each, `summarizeOffline` on a throwaway store, and `materializeSession` into the real store. Pauses `backgroundIntervalMs` between ticks. Stops when drained.

**Files:**
- Create: `server/src/indexer.ts`
- Create: `server/src/indexer.test.ts`
- Modify: `server/src/store.ts` — add `getSessionSummary(id)` (used by Task 7, added here for cohesion).
- Modify: `server/src/monitor.ts` — construct + start the indexer at the end of `startWatching()`.

- [ ] **Step 1: Write the failing test**

Create `server/src/indexer.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { BackgroundIndexer } from './indexer.js';

function fakeDeps(files: string[]) {
  const written: string[] = [];
  return {
    written,
    deps: {
      takeFiles: () => files.splice(0, files.length),
      parseFile: async (p: string) => [
        { session_id: p.replace('.jsonl', ''), agent_id: null, uuid: p, parent_uuid: null,
          ts: '2020-01-01T00:00:00.000Z', cwd: '/tmp', kind: 'user_text', tags: [], payload: { text: 'x' } },
      ],
      summarize: (events: any[]) => ({ session_id: events[0].session_id }),
      write: (row: any) => { written.push(row.session_id); },
      batchSize: 2,
      intervalMs: 0,
    },
  };
}

describe('BackgroundIndexer', () => {
  it('drains all deferred files into summary writes', async () => {
    const { written, deps } = fakeDeps(['a.jsonl', 'b.jsonl', 'c.jsonl']);
    const ix = new BackgroundIndexer(deps as any);
    await ix.runToCompletion();
    expect(written.sort()).toEqual(['a', 'b', 'c']);
  });

  it('stop() halts further ticks', async () => {
    const { written, deps } = fakeDeps(['a.jsonl', 'b.jsonl', 'c.jsonl', 'd.jsonl']);
    const ix = new BackgroundIndexer({ ...deps, batchSize: 1, intervalMs: 5 } as any);
    const p = ix.runToCompletion();
    ix.stop();
    await p;
    expect(written.length).toBeLessThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w server -- src/indexer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the indexer**

Create `server/src/indexer.ts`:

```typescript
import type { Event } from './parser.js';
import type { SessionSummaryRow } from './store.js';

export interface IndexerDeps {
  /** Pull (and clear) the next batch source. Returns ALL outstanding files;
   * the indexer paces them itself in batches of `batchSize`. */
  takeFiles: () => string[];
  parseFile: (absPath: string) => Promise<Event[]>;
  summarize: (events: Event[]) => SessionSummaryRow | null;
  write: (row: SessionSummaryRow) => void;
  batchSize: number;
  intervalMs: number;
}

/** Throttled background summarizer. Drains a queue of older transcript files
 * into session_summary, never creating panels or emitting deltas. */
export class BackgroundIndexer {
  private stopped = false;
  constructor(private readonly deps: IndexerDeps) {}

  stop(): void {
    this.stopped = true;
  }

  /** Process the entire queue, pausing `intervalMs` between batches. Resolves
   * when drained or stopped. Errors on a single file are swallowed so one bad
   * transcript can't wedge the pass. */
  async runToCompletion(): Promise<void> {
    const queue = this.deps.takeFiles();
    let i = 0;
    while (i < queue.length && !this.stopped) {
      const batch = queue.slice(i, i + this.deps.batchSize);
      i += this.deps.batchSize;
      for (const file of batch) {
        if (this.stopped) return;
        try {
          const events = await this.deps.parseFile(file);
          if (events.length === 0) continue;
          const row = this.deps.summarize(events);
          if (row) this.deps.write(row);
        } catch {
          // skip unreadable/unparseable file
        }
      }
      if (i < queue.length && !this.stopped && this.deps.intervalMs > 0) {
        await new Promise((r) => setTimeout(r, this.deps.intervalMs));
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w server -- src/indexer.test.ts`
Expected: PASS.

- [ ] **Step 5: Add `getSessionSummary` to the store**

In `server/src/store.ts`, near `sessionsForProject`, add:

```typescript
  /** Single session_summary row by id, or null. */
  getSessionSummary(sessionId: string): SessionSummaryRow | null {
    const row = this.db
      .prepare('SELECT * FROM session_summary WHERE session_id = ?')
      .get(sessionId) as SessionSummaryRow | undefined;
    return row ?? null;
  }
```

- [ ] **Step 6: Kick off the indexer in `monitor.startWatching()`**

In `server/src/monitor.ts`, add a field + construct/start at the end of `startWatching()` (after `watcher.start({watch:true})`, ~line 184), using a throwaway `SessionStore` for summarization:

```typescript
  private indexer: BackgroundIndexer | null = null;

  // ...at the end of startWatching(), after the watcher has bootstrapped:
  if (this.persistStore && this.discovery && this.discovery.backgroundMaxAgeSeconds > 0) {
    const scratch = new SessionStore({
      clock: () => Date.now() / 1000,
      isSessionLive: () => false,
      store: null, // never persists panels / emits deltas
    });
    this.indexer = new BackgroundIndexer({
      takeFiles: () => this.watcher.takeDeferredFiles(),
      parseFile: (p) => this.watcher.parseFile(p),
      summarize: (events) => {
        scratch.reset?.(); // see note below
        return scratch.summarizeOffline(events);
      },
      write: (row) => this.persistStore?.materializeSession(row),
      batchSize: this.discovery.backgroundBatchSize,
      intervalMs: this.discovery.backgroundIntervalMs,
    });
    void this.indexer.runToCompletion();
  }
```

Wire `this.discovery` from `MonitorOptions` (add `discovery?: Discovery` to `MonitorOptions`, set `this.discovery = opts.discovery ?? null` in the constructor, and pass `discovery` from `index.ts` Task 3's edit). Import `BackgroundIndexer` and `SessionStore`.

**Scratch-store reuse note:** `summarizeOffline` accumulates into `scratch.panels`. To avoid cross-file bleed, give `SessionStore` a tiny `reset()` that clears `this.panels` (add: `reset(): void { this.panels.clear(); }`), OR construct a fresh `SessionStore` per file inside `summarize`. Per-file construction is simplest and avoids the `reset` method — prefer that unless profiling shows it matters:

```typescript
      summarize: (events) => new SessionStore({
        clock: () => Date.now() / 1000, isSessionLive: () => false, store: null,
      }).summarizeOffline(events),
```

- [ ] **Step 7: Run tests + build**

Run: `npm run test -w server`
Expected: PASS.
Run: `npm run build:server`
Expected: clean tsc.

- [ ] **Step 8: Commit**

```bash
git add server/src/indexer.ts server/src/indexer.test.ts server/src/store.ts server/src/monitor.ts server/src/index.ts
git commit -m "feat(server): throttled background indexer fills session_summary for older sessions"
```

---

### Task 7: `reopenSession` mutation + on-demand fast-load

Parse a single transcript on demand and feed it through `apply()` so the panel surfaces immediately, ahead of the background pace. Back the existing `openSessionFromWidget` no-op.

**Files:**
- Modify: `server/src/monitor.ts` — `reopenSession(sessionId)`.
- Modify: `server/src/trpc.ts` — `reopenSession` mutation (alongside `restore`/`remove`, ~line 84-95).
- Modify: `client/src/App.tsx` — `openSessionFromWidget` (651-679).
- Test: `server/src/monitor.test.ts` (append; if no file, create with the temp-root helpers used by `watcher.test.ts`).

- [ ] **Step 1: Implement `monitor.reopenSession`**

In `server/src/monitor.ts`, add (uses `encodeCwdToProjectDir` from `./session.js`, `path`/`existsSync` from node):

```typescript
  /** Re-create a reaped/never-surfaced session as a live panel on demand.
   * Resolves the transcript from its persisted cwd, parses it fully, and
   * feeds it through the normal apply() path so deltas reach subscribers.
   * No-op (returns false) if the session isn't known or its file is gone. */
  async reopenSession(sessionId: string): Promise<boolean> {
    if (this.store.snapshotHas(sessionId)) return true; // already live
    const row = this.persistStore?.getSessionSummary(sessionId);
    if (!row || !row.cwd) return false;
    const rel = encodeCwdToProjectDir(row.cwd);
    for (const root of this.watcher.roots) {
      const file = path.join(root, rel, `${sessionId}.jsonl`);
      if (!existsSync(file)) continue;
      const events = await this.watcher.parseFile(file);
      for (const event of events) {
        const deltas = this.store.apply(event, { accountLabel: row.account_label });
        for (const d of deltas) this.emitter.emit('delta', d);
      }
      return true;
    }
    return false;
  }
```

Add a tiny `snapshotHas` helper to `SessionStore` (session.ts) so reopen can short-circuit a live session:

```typescript
  snapshotHas(id: string): boolean {
    const p = this.panels.get(id);
    return !!p && p.binned_at === null;
  }
```

- [ ] **Step 2: Add the tRPC mutation**

In `server/src/trpc.ts`, alongside `restore`/`remove` (84-95):

```typescript
  reopenSession: t.procedure
    .input(z.object({ sessionId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const ok = await ctx.monitor.reopenSession(input.sessionId);
      return { ok };
    }),
```

- [ ] **Step 3: Write the failing server test**

Append to `server/src/monitor.test.ts` (reuse temp-root helpers; sketch):

```typescript
describe('reopenSession', () => {
  it('surfaces a reaped session from disk via deltas', async () => {
    // 1. write a transcript under a temp root; materialize its summary row
    //    (so getSessionSummary resolves cwd) but do NOT bootstrap it.
    // 2. subscribe to monitor.emitter 'delta'
    // 3. await monitor.reopenSession(sessionId) → expect true
    // 4. expect a panel_upsert delta for sessionId was emitted
    //    and store.snapshotHas(sessionId) is true.
  });
});
```

Fill in using the same helpers `watcher.test.ts` uses to build a root + write JSONL, and the monitor construction from existing monitor tests.

- [ ] **Step 4: Run server test + build**

Run: `npm run test -w server -- src/monitor.test.ts`
Expected: PASS.
Run: `npm run build:server`
Expected: clean tsc.

- [ ] **Step 5: Wire the client**

In `client/src/App.tsx`, replace the no-op early return in `openSessionFromWidget` (651-679). Change:

```typescript
  const panel = panels.get(sessionId);
  if (!panel) {
    // ...TODO comment...
    return;
  }
```

to:

```typescript
  const panel = panels.get(sessionId);
  if (!panel) {
    // Reaped/older session not in the live map — ask the server to parse its
    // transcript and re-surface it. The panel arrives via the delta stream
    // (panel_upsert), so we just fire-and-forget; the reducer mounts it.
    trpc.reopenSession.mutate({ sessionId }).catch(() => undefined);
    return;
  }
```

(Keep the rest of the function unchanged for the in-map case.)

- [ ] **Step 6: Build client + typecheck**

Run: `npm run build:client`
Expected: clean tsc + vite build.

- [ ] **Step 7: Commit**

```bash
git add server/src/monitor.ts server/src/trpc.ts server/src/monitor.test.ts client/src/App.tsx
git commit -m "feat: reopenSession on-demand fast-load for reaped/older sessions"
```

---

### Task 8: Full verification

- [ ] **Step 1: Whole suite + build**

Run: `npm run build && npm run test`
Expected: server + client builds clean; all server + client tests pass.

- [ ] **Step 2: Lint touched files**

Run: `npx biome check --write server/src/indexer.ts server/src/session.ts server/src/watcher.ts server/src/monitor.ts server/src/store.ts server/src/prefs.ts server/src/trpc.ts client/src/App.tsx`
Expected: no new errors (pre-existing App.tsx lint findings unrelated to this work are acceptable).

- [ ] **Step 3: Live smoke test (isolated instance — do NOT disturb a running :8765)**

```bash
PORT=8767 BRAINHOUSE_DB=/tmp/cold-start-verify.sqlite node server/dist/index.js
```

Confirm in the browser (http://localhost:8767):
- On load, the grid shows only live/recently-active sessions (no flood of UUID-titled panels).
- Project widgets' session lists still populate older sessions (background indexer filled `session_summary`) — check after a few seconds.
- Clicking an older session row in a project widget surfaces it (reopenSession).

Then clean up: kill the process, `rm -f /tmp/cold-start-verify.sqlite*`.

- [ ] **Step 4: Append assertions + update TODO**

- Add a rule to `docs/assertions.md` describing the surfacing gate ("only live-or-within-uiWindow sessions surface as panels; older sessions are summary-only until reopened").
- Mark the cold-start item done in `TODO.md` and note `discovery.*` prefs + the `reopenSession` path.

```bash
git add docs/assertions.md TODO.md
git commit -m "docs: record cold-start surfacing-gate assertion + close TODO"
```

---

## Self-Review

**Spec coverage:**
- Conservative cold start (live-or-within-48h) → Task 2 (snapshot gate) + Task 3 (window from prefs). ✓
- Title gate (never surface old+titleless) → Task 2 (recency gate subsumes it; explicit form noted). ✓
- Background indexing into session_summary, throttled, no panels/deltas → Tasks 4 (collect), 5 (`summarizeOffline`/`parseFile`), 6 (`BackgroundIndexer`). ✓
- On-demand fast-load → Task 7 (`reopenSession` + client wiring). ✓
- Config (`discovery.uiWindowSeconds`, background throttle, 90-day bound) → Task 1. ✓
- Non-goals respected: live ingestion path unchanged (apply() untouched for live files); lifecycle timings untouched; `defaultRoots()` untouched. ✓

**Type consistency:** `uiWindowSeconds` used identically in prefs (Task 1), `MonitorOptions`/`SessionStore` (Tasks 3) and the gate (Task 2). `SessionSummaryRow` is the single shape across `summarizeOffline` (Task 5), `BackgroundIndexer.write`/`getSessionSummary` (Task 6), and `materializeSession`. `takeDeferredFiles`/`parseFile`/`summarizeOffline`/`reopenSession`/`snapshotHas`/`getSessionSummary` names are used consistently across producer and consumer tasks.

**Known confirm-on-execution points (read the cited lines before editing; not placeholders):**
1. Exact field names on the parser `Event` type (the test factories assume `kind: 'user_text'`, `payload: { text }`) — confirm against `server/src/parser.ts` and adapt the helper if the discriminant differs.
2. `SessionStore` constructor options object shape (Task 2/3/5) — confirm option names (`clock`, `isSessionLive`, `store`) against the existing constructor; the survey shows `isSessionLive` and `store`, `clock` is used via `this.clock()`.
3. `MonitorOptions` already carries `store` as `persistStore`; confirm whether to read `discovery` directly or pass individual fields.
4. Reuse the existing temp-root/JSONL helpers in `watcher.test.ts` for Tasks 4 and 7 rather than re-implementing them.
