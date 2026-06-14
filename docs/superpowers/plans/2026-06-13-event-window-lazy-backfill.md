# Bounded Live Event Window + Lazy JSONL Backfill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cap the client's per-panel event retention (the source of multi-GB renderer growth) while letting the user scroll back past the live window by lazily re-parsing the session JSONL on demand.

**Architecture:** Bound the live `Event[]` at the data layer (`useDeltaStream` reducer) so memory is bounded everywhere. Add a read-only server tRPC query that re-parses a panel's transcript JSONL and returns an older slice. A shared client hook fetches older events on scroll-up, holds them in transient per-view state, anchors the scroll position on prepend, and drops them when the user returns to the tail.

**Tech Stack:** TypeScript, React (hooks + `useReducer`), tRPC v11 (vanilla client), Vitest, existing `parseJsonlToPanel` transcript parser.

**Spec:** `docs/superpowers/specs/2026-06-13-event-window-lazy-backfill-design.md`

---

## File Structure

- **`client/src/useDeltaStream.ts`** (modify) — add the live-window cap + chunked eviction in the reducer; export the tuning constants for tests.
- **`server/src/monitor.ts`** (modify) — factor a read-only `sourceFileForPanel(panelId)` resolver out of the existing `rebuildPanel` file-resolution logic.
- **`server/src/history.ts`** (create) — pure `sliceHistory(events, beforeUuid, limit)` helper (parse-and-slice logic, unit-testable without fs).
- **`server/src/trpc.ts`** (modify) — add the `panelHistory` query procedure.
- **`client/src/lib/useScrollBackfill.ts`** (create) — shared hook: fetch/merge/clear core + scroll-anchor effect.
- **`client/src/components/EventList.tsx`** / **`client/src/components/PanelCard.tsx`** (modify) — wire the hook into the render surfaces.

---

## Task 1: Bound the live window in the reducer (client)

**Files:**
- Modify: `client/src/useDeltaStream.ts`
- Test: `client/src/useDeltaStream.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `client/src/useDeltaStream.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Event } from '@server/parser.ts';
import type { PanelDto } from '@server/session.ts';
import { EVICT_CHUNK, LIVE_WINDOW, reducer, initialState } from './useDeltaStream.ts';

function ev(uuid: string): Event {
  // Minimal Event; only `uuid` is read by these assertions.
  return { kind: 'assistant_text', uuid, parent_uuid: null, ts: '2026-01-01T00:00:00Z' } as Event;
}

function panel(id: string): PanelDto {
  return { id } as PanelDto;
}

describe('useDeltaStream reducer — live window cap', () => {
  it('keeps all events while under the cap', () => {
    let s = reducer(initialState, { type: 'snapshot', panels: [{ ...panel('S'), events: [] }] });
    for (let i = 0; i < LIVE_WINDOW; i++) {
      s = reducer(s, { type: 'delta', delta: { op: 'event_append', panel_id: 'S', event: ev(`e${i}`) } });
    }
    expect(s.panels.get('S')!.events.length).toBe(LIVE_WINDOW);
  });

  it('trims oldest in chunks once over the cap, preserving tail order', () => {
    let s = reducer(initialState, { type: 'snapshot', panels: [{ ...panel('S'), events: [] }] });
    const total = LIVE_WINDOW + EVICT_CHUNK + 1;
    for (let i = 0; i < total; i++) {
      s = reducer(s, { type: 'delta', delta: { op: 'event_append', panel_id: 'S', event: ev(`e${i}`) } });
    }
    const evs = s.panels.get('S')!.events;
    expect(evs.length).toBe(LIVE_WINDOW - EVICT_CHUNK + 1);
    // newest event is always retained
    expect(evs[evs.length - 1].uuid).toBe(`e${total - 1}`);
    // order is contiguous (no gaps from the splice)
    for (let i = 1; i < evs.length; i++) {
      const prev = Number(evs[i - 1].uuid.slice(1));
      const cur = Number(evs[i].uuid.slice(1));
      expect(cur).toBe(prev + 1);
    }
  });

  it('caps the snapshot path to LIVE_WINDOW', () => {
    const events = Array.from({ length: LIVE_WINDOW + 500 }, (_, i) => ev(`e${i}`));
    const s = reducer(initialState, { type: 'snapshot', panels: [{ ...panel('S'), events }] });
    expect(s.panels.get('S')!.events.length).toBe(LIVE_WINDOW);
    expect(s.panels.get('S')!.events[0].uuid).toBe(`e500`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npx vitest run src/useDeltaStream.test.ts`
Expected: FAIL — `EVICT_CHUNK`/`LIVE_WINDOW` are not exported (import error), or length assertions fail.

- [ ] **Step 3: Add the constants and a trim helper**

At the top of `client/src/useDeltaStream.ts`, after the imports, add:

```ts
/** Max events kept in memory per panel. Older events live in the
 * session JSONL on disk and are re-fetched on scroll-back via the
 * `panelHistory` query. Mirrors the server's own cap policy. */
export const LIVE_WINDOW = 1500;
/** Trim in chunks so splices are occasional, not per-event. */
export const EVICT_CHUNK = 150;

/** Append `e`, then drop the oldest chunk if we've crossed the cap.
 * Returns a new array (never mutates `existing`). */
function appendCapped(existing: Event[], e: Event): Event[] {
  const next = [...existing, e];
  if (next.length > LIVE_WINDOW) return next.slice(next.length - (LIVE_WINDOW - EVICT_CHUNK));
  return next;
}
```

- [ ] **Step 4: Use the helper in the reducer**

In `client/src/useDeltaStream.ts`, in the `event_append` branch, replace:

```ts
          panels.set(d.panel_id, {
            ...existing,
            events: [...existing.events, d.event],
            last_event_at: Date.now() / 1000,
          });
```

with:

```ts
          panels.set(d.panel_id, {
            ...existing,
            events: appendCapped(existing.events, d.event),
            last_event_at: Date.now() / 1000,
          });
```

In the `snapshot` branch, replace:

```ts
      for (const p of action.panels) panels.set(p.id, { ...p, events: p.events });
```

with:

```ts
      for (const p of action.panels)
        panels.set(p.id, { ...p, events: p.events.slice(-LIVE_WINDOW) });
```

In the `panel_upsert` branch, the reseeded `events` (dock-restore) should also be capped. Replace:

```ts
        const events = d.events ?? existing?.events ?? [];
        panels.set(d.panel.id, { ...d.panel, events });
```

with:

```ts
        const events = (d.events ?? existing?.events ?? []).slice(-LIVE_WINDOW);
        panels.set(d.panel.id, { ...d.panel, events });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd client && npx vitest run src/useDeltaStream.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add client/src/useDeltaStream.ts client/src/useDeltaStream.test.ts
git commit -m "perf(client): cap per-panel live event window at 1500"
```

---

## Task 2: Pure history-slice helper (server)

**Files:**
- Create: `server/src/history.ts`
- Test: `server/src/history.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `server/src/history.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Event } from './parser.js';
import { sliceHistory } from './history.js';

function ev(uuid: string): Event {
  return { kind: 'assistant_text', uuid, parent_uuid: null, ts: '2026-01-01T00:00:00Z' } as Event;
}

const all = ['a', 'b', 'c', 'd', 'e'].map(ev); // chronological

describe('sliceHistory', () => {
  it('returns the `limit` events immediately before the cursor', () => {
    const r = sliceHistory(all, 'd', 2);
    expect(r.events.map((e) => e.uuid)).toEqual(['b', 'c']);
    expect(r.hasMore).toBe(true); // 'a' is still older than 'b'
  });

  it('clamps at the start of the file and reports hasMore=false', () => {
    const r = sliceHistory(all, 'c', 10);
    expect(r.events.map((e) => e.uuid)).toEqual(['a', 'b']);
    expect(r.hasMore).toBe(false);
  });

  it('returns empty + hasMore=false when the cursor is the first event', () => {
    const r = sliceHistory(all, 'a', 5);
    expect(r.events).toEqual([]);
    expect(r.hasMore).toBe(false);
  });

  it('returns empty + hasMore=false when the cursor is unknown', () => {
    const r = sliceHistory(all, 'zzz', 5);
    expect(r.events).toEqual([]);
    expect(r.hasMore).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/history.test.ts`
Expected: FAIL — `Cannot find module './history.js'`.

- [ ] **Step 3: Write the implementation**

Create `server/src/history.ts`:

```ts
/**
 * Pure slice helper for lazy scroll-back. Given a panel's full
 * chronological event list (as parsed from its JSONL) and the uuid of
 * the oldest event the client currently holds, return the `limit`
 * events immediately preceding it.
 */
import type { Event } from './parser.js';

export interface HistorySlice {
  events: Event[];
  /** True iff there are still older events before the returned slice. */
  hasMore: boolean;
}

export function sliceHistory(all: Event[], beforeUuid: string, limit: number): HistorySlice {
  const idx = all.findIndex((e) => e.uuid === beforeUuid);
  if (idx <= 0) return { events: [], hasMore: false };
  const start = Math.max(0, idx - limit);
  return { events: all.slice(start, idx), hasMore: start > 0 };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/history.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/history.ts server/src/history.test.ts
git commit -m "feat(server): add pure sliceHistory helper for scroll-back"
```

---

## Task 3: Read-only panel→file resolver (server)

**Files:**
- Modify: `server/src/monitor.ts` (factor resolver out of `rebuildPanel`, around lines 423-451)

This task has no standalone unit test (it depends on the live watcher/store and filesystem layout); it is exercised by the Task 4 integration test. Keep it a thin, side-effect-free extraction.

- [ ] **Step 1: Verify the subagent file-naming convention**

Before writing the resolver, confirm how subagent JSONLs are named on disk so the resolver can handle subagent panels (the spec flagged this as open):

Run: `ls ~/.claude/projects/*/.*/subagents/ 2>/dev/null | head; find ~/.claude/projects -path '*/subagents/*.jsonl' 2>/dev/null | head`
Expected: paths like `.../<parentId>/subagents/<something>.jsonl`. Note whether `<something>` is the subagent panel id (`agent_id`) — that determines the subagent branch below. If subagent files are not found / not named by panel id, the resolver returns `null` for subagents (they degrade to no-backfill; the live window still works) and we file subagent backfill as a follow-up.

- [ ] **Step 2: Add the resolver method**

In `server/src/monitor.ts`, add a public method on the monitor class (near `rebuildPanel`). This reuses the same `encodeCwdToProjectDir` + `watcher.roots` resolution that `rebuildPanel` already uses, but is read-only:

```ts
  /** Resolve the transcript JSONL that owns a panel's events, or null if
   * it can't be found on disk. Read-only — no store/broadcast side
   * effects. Used by the `panelHistory` query for lazy scroll-back. */
  sourceFileForPanel(panelId: string): string | null {
    const panel = this.store.panel(panelId);
    if (!panel) return null;
    // Subagent events live in their own file under the parent's
    // `subagents` dir; resolve relative to the owning parent's cwd.
    const owner =
      panel.kind === 'parent'
        ? panel
        : panel.parent_panel_id
          ? this.store.panel(panel.parent_panel_id)
          : null;
    if (!owner?.cwd) return null;
    const encoded = encodeCwdToProjectDir(owner.cwd);
    for (const root of this.watcher.roots) {
      if (panel.kind === 'parent') {
        const candidate = path.join(root, encoded, `${panelId}.jsonl`);
        if (existsSync(candidate)) return candidate;
      } else {
        const candidate = path.join(root, encoded, owner.id, 'subagents', `${panelId}.jsonl`);
        if (existsSync(candidate)) return candidate;
      }
    }
    return null;
  }
```

> If Step 1 showed subagent files are NOT named `<panelId>.jsonl`, change the subagent `candidate` to match the real convention, or `return null` in the `else` branch and note the follow-up. Do not invent a path.

- [ ] **Step 3: Verify it compiles**

Run: `cd server && npx tsc --noEmit`
Expected: no new errors referencing `monitor.ts` (`existsSync`, `path`, and `encodeCwdToProjectDir` are already imported in this file — confirm; if `existsSync` isn't imported, add `import { existsSync } from 'node:fs';`).

- [ ] **Step 4: Commit**

```bash
git add server/src/monitor.ts
git commit -m "feat(server): read-only sourceFileForPanel resolver"
```

---

## Task 4: `panelHistory` tRPC query (server)

**Files:**
- Modify: `server/src/trpc.ts` (add procedure; reuse `loadJsonlAsPanel` from `./replay.js` which is already imported, and `sliceHistory` from `./history.js`)
- Test: `server/src/index.test.ts` (add a case; this file already constructs `appRouter.createCaller`)

- [ ] **Step 1: Write the failing test**

First inspect `server/src/index.test.ts` to match its existing context-construction pattern (it builds `{ monitor, prefs }` and calls `appRouter.createCaller`). Add a test that writes a fixture JSONL, points a stub monitor's `sourceFileForPanel` at it, and asserts the slice. Append to `server/src/index.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('panelHistory', () => {
  it('returns older events parsed from the panel JSONL', async () => {
    // Two assistant_text lines → two events, chronological.
    const line = (uuid: string, text: string) =>
      JSON.stringify({ type: 'assistant', uuid, timestamp: '2026-01-01T00:00:00Z', message: { content: [{ type: 'text', text }] } });
    const dir = mkdtempSync(join(tmpdir(), 'bh-hist-'));
    const file = join(dir, 'S.jsonl');
    writeFileSync(file, [line('u1', 'one'), line('u2', 'two'), line('u3', 'three')].join('\n'));

    const monitor = { sourceFileForPanel: (id: string) => (id === 'S' ? file : null) } as any;
    const prefs = { get: () => ({}) } as any;
    const caller = appRouter.createCaller({ monitor, prefs, store: null, tracker: null });

    const res = await caller.panelHistory({ panelId: 'S', beforeUuid: 'u3', limit: 10 });
    expect(res.events.map((e: any) => e.uuid)).toEqual(['u1', 'u2']);
    expect(res.hasMore).toBe(false);
  });

  it('returns empty when the panel has no resolvable file', async () => {
    const monitor = { sourceFileForPanel: () => null } as any;
    const prefs = { get: () => ({}) } as any;
    const caller = appRouter.createCaller({ monitor, prefs, store: null, tracker: null });
    const res = await caller.panelHistory({ panelId: 'nope', beforeUuid: 'x', limit: 10 });
    expect(res).toEqual({ events: [], hasMore: false });
  });
});
```

> If the real parser maps `assistant` text records to a different `uuid` (e.g. a `-text` suffix per the content-block fan-out noted in `parser.ts`), adjust the expected uuids to match what `loadJsonlAsPanel(file)` actually returns — run the test once and read the received values rather than guessing.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/index.test.ts -t panelHistory`
Expected: FAIL — `caller.panelHistory is not a function`.

- [ ] **Step 3: Add the procedure**

In `server/src/trpc.ts`, add `import { sliceHistory } from './history.js';` to the imports, then add this procedure to the `appRouter` object (e.g. just before `deltas:`):

```ts
  /** Lazy scroll-back: re-parse a panel's transcript JSONL and return the
   * `limit` events immediately before `beforeUuid`. Read-only; the full
   * history lives in the JSONL, not the in-memory window. */
  panelHistory: t.procedure
    .input(z.object({ panelId: z.string(), beforeUuid: z.string(), limit: z.number().int().positive().max(2000).default(500) }))
    .query(async ({ ctx, input }) => {
      const file = ctx.monitor.sourceFileForPanel(input.panelId);
      if (!file) return { events: [], hasMore: false };
      const { events } = await loadJsonlAsPanel(file);
      return sliceHistory(events, input.beforeUuid, input.limit);
    }),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/index.test.ts -t panelHistory`
Expected: PASS (2 tests). If uuids mismatch, apply the adjustment from Step 1's note and re-run.

- [ ] **Step 5: Commit**

```bash
git add server/src/trpc.ts server/src/index.test.ts
git commit -m "feat(server): panelHistory query for lazy scroll-back"
```

---

## Task 5: Shared backfill hook (client)

**Files:**
- Create: `client/src/lib/useScrollBackfill.ts`
- Test: `client/src/lib/useScrollBackfill.test.tsx` (create)

The hook has two parts: a **testable data core** (fetch older, merge, single-flight, hasMore, clear-on-tail) and a **DOM scroll-anchor effect** (not unit-testable under jsdom because it has no layout — verified manually in Task 6). Keep them in one hook but structure so the data behavior is exercised by tests.

- [ ] **Step 1: Write the failing test (data core)**

Create `client/src/lib/useScrollBackfill.test.tsx`:

```tsx
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Event } from '@server/parser.ts';
import { useScrollBackfill } from './useScrollBackfill.ts';

const queryMock = vi.fn();
vi.mock('../trpc.ts', () => ({
  trpc: { panelHistory: { query: (...a: unknown[]) => queryMock(...a) } },
}));

function ev(uuid: string): Event {
  return { kind: 'assistant_text', uuid, parent_uuid: null, ts: '2026-01-01T00:00:00Z' } as Event;
}
const bodyRef = { current: { scrollTop: 0, scrollHeight: 0, clientHeight: 0 } } as any;

afterEach(() => queryMock.mockReset());

describe('useScrollBackfill', () => {
  it('prepends fetched older events to the live events', async () => {
    queryMock.mockResolvedValue({ events: [ev('old1'), ev('old2')], hasMore: true });
    const live = [ev('live1')];
    const { result } = renderHook(() =>
      useScrollBackfill({ bodyRef, panelId: 'S', liveEvents: live, hasMore: true }),
    );
    expect(result.current.mergedEvents.map((e) => e.uuid)).toEqual(['live1']);
    await act(async () => { await result.current.loadOlder(); });
    expect(result.current.mergedEvents.map((e) => e.uuid)).toEqual(['old1', 'old2', 'live1']);
    expect(queryMock).toHaveBeenCalledWith({ panelId: 'S', beforeUuid: 'live1', limit: 500 });
  });

  it('does not issue a second fetch while one is in flight', async () => {
    let resolve!: (v: unknown) => void;
    queryMock.mockReturnValue(new Promise((r) => { resolve = r; }));
    const { result } = renderHook(() =>
      useScrollBackfill({ bodyRef, panelId: 'S', liveEvents: [ev('live1')], hasMore: true }),
    );
    act(() => { void result.current.loadOlder(); void result.current.loadOlder(); });
    expect(queryMock).toHaveBeenCalledTimes(1);
    await act(async () => { resolve({ events: [ev('old1')], hasMore: false }); });
  });

  it('clears the backfill buffer when reset() is called (return-to-tail)', async () => {
    queryMock.mockResolvedValue({ events: [ev('old1')], hasMore: false });
    const { result } = renderHook(() =>
      useScrollBackfill({ bodyRef, panelId: 'S', liveEvents: [ev('live1')], hasMore: true }),
    );
    await act(async () => { await result.current.loadOlder(); });
    expect(result.current.mergedEvents).toHaveLength(2);
    act(() => result.current.reset());
    expect(result.current.mergedEvents.map((e) => e.uuid)).toEqual(['live1']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npx vitest run src/lib/useScrollBackfill.test.tsx`
Expected: FAIL — `Cannot find module './useScrollBackfill.ts'`.

- [ ] **Step 3: Write the hook**

Create `client/src/lib/useScrollBackfill.ts`:

```ts
import type { Event } from '@server/parser.ts';
import { type RefObject, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { trpc } from '../trpc.ts';

const HISTORY_PAGE = 500;
/** Fire backfill when the scroll container is within this many px of top. */
const TOP_TRIGGER_PX = 200;

interface Args {
  bodyRef: RefObject<HTMLElement | null>;
  panelId: string;
  liveEvents: Event[];
  /** Whether the server has older events than the live window holds. */
  hasMore: boolean;
}

export interface ScrollBackfill {
  mergedEvents: Event[];
  loadOlder: () => Promise<void>;
  reset: () => void;
  /** Attach to the scroll container's onScroll. */
  onScroll: () => void;
}

export function useScrollBackfill({ bodyRef, panelId, liveEvents, hasMore }: Args): ScrollBackfill {
  const [older, setOlder] = useState<Event[]>([]);
  const [moreBelowCursor, setMoreBelowCursor] = useState(true);
  const inFlight = useRef(false);
  // scrollHeight captured just before a prepend, so we can restore position.
  const anchorRef = useRef<number | null>(null);

  // A new panel resets all transient history state.
  const lastPanel = useRef(panelId);
  if (lastPanel.current !== panelId) {
    lastPanel.current = panelId;
    setOlder([]);
    setMoreBelowCursor(true);
    inFlight.current = false;
  }

  const mergedEvents = useMemo(() => [...older, ...liveEvents], [older, liveEvents]);

  const loadOlder = useCallback(async () => {
    if (inFlight.current) return;
    if (!hasMore && !moreBelowCursor) return;
    const cursor = (older[0] ?? liveEvents[0])?.uuid;
    if (!cursor) return;
    inFlight.current = true;
    anchorRef.current = bodyRef.current?.scrollHeight ?? null;
    try {
      const res = await trpc.panelHistory.query({ panelId, beforeUuid: cursor, limit: HISTORY_PAGE });
      if (res.events.length) setOlder((prev) => [...res.events, ...prev]);
      setMoreBelowCursor(res.hasMore);
    } finally {
      inFlight.current = false;
    }
  }, [bodyRef, hasMore, liveEvents, moreBelowCursor, older, panelId]);

  const reset = useCallback(() => {
    setOlder([]);
    setMoreBelowCursor(true);
  }, []);

  // Restore scroll position after older events are prepended so the
  // viewport stays anchored on the same event instead of jumping.
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (el && anchorRef.current != null) {
      el.scrollTop += el.scrollHeight - anchorRef.current;
      anchorRef.current = null;
    }
  }, [older, bodyRef]);

  const onScroll = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    if (el.scrollTop <= TOP_TRIGGER_PX) void loadOlder();
  }, [bodyRef, loadOlder]);

  return { mergedEvents, loadOlder, reset, onScroll };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && npx vitest run src/lib/useScrollBackfill.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/useScrollBackfill.ts client/src/lib/useScrollBackfill.test.tsx
git commit -m "feat(client): useScrollBackfill hook for lazy event backfill"
```

---

## Task 6: Wire the hook into PanelCard / EventList

**Files:**
- Modify: `client/src/components/PanelCard.tsx` (owns `bodyRef`, the scroll container, and `stickToBottomRef`)
- Modify: `client/src/components/EventList.tsx` (renders the merged list)

PanelCard is the primary surface and owns the scroll container. The expanded/broken-out view and TraceTab reuse `EventList`; once PanelCard passes merged events, extend those surfaces the same way (each calls `useScrollBackfill` with its own scroll ref). This task covers PanelCard; replicate the 4-line wiring in the other surfaces in a follow-up commit if they own separate scroll containers.

- [ ] **Step 1: Compute hasMore and merged events in PanelCard**

In `client/src/components/PanelCard.tsx`, near the other hooks (after `bodyRef` is declared, ~line 113), add:

```ts
  const hasOlderHistory = panel.event_count > panel.events.length;
  const { mergedEvents, reset: resetBackfill, onScroll: onBackfillScroll } = useScrollBackfill({
    bodyRef,
    panelId: panel.id,
    liveEvents: panel.events,
    hasMore: hasOlderHistory,
  });
```

Add the import at the top:

```ts
import { useScrollBackfill } from '../lib/useScrollBackfill.ts';
```

> Confirm the prop that carries this panel's events into `PanelCard` is `panel.events` and that `PanelDto` exposes `event_count` (it does — `session.ts:624,828`). If events arrive via a differently-named prop, use that name.

- [ ] **Step 2: Feed merged events to EventList and trigger backfill on scroll-up**

Find where `PanelCard` renders `<EventList events={...} .../>` and change the `events` prop to `mergedEvents`.

In the existing `onScroll` handler on the `bodyRef` element (~line 385), call the backfill scroll check and reset-on-return-to-tail. Inside that handler, after the `stickToBottomRef.current = ...` line, add:

```ts
            onBackfillScroll();
            // Returning to the bottom drops the backfill buffer so deep
            // scroll-back never becomes standing memory.
            if (stickToBottomRef.current) resetBackfill();
```

- [ ] **Step 3: Verify build + existing tests**

Run: `cd client && npx vitest run src/components/PanelCard.test.tsx && npx tsc -b --pretty false 2>&1 | grep -E "PanelCard|EventList|useScrollBackfill" || echo "no new errors in touched files"`
Expected: PanelCard tests PASS; no new type errors in the touched files. (Pre-existing unrelated errors elsewhere are tracked separately — see the spec's note that `main` does not currently typecheck.)

- [ ] **Step 4: Manual verification of scroll-anchoring (cannot be unit-tested under jsdom)**

Run the app and confirm scroll-back works without the viewport jumping:

```bash
# dev server is typically already running on :8766
```

In the browser: open a panel with a long history, scroll to the top — older events should load and prepend, and the viewport should stay anchored on the event you were reading (no jump). Scroll back to the bottom — confirm new live events still auto-pin. Optionally re-run the heap audit (load app, force GC, sample `JSHeapUsedSize` + DOM node count over ~60s while streaming) and confirm the heap stays flat and bounded.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/PanelCard.tsx client/src/components/EventList.tsx
git commit -m "feat(client): lazy scroll-back wiring in PanelCard"
```

---

## Self-Review

**Spec coverage:**
- Server `panelHistory` procedure → Tasks 2, 3, 4. ✓
- `panelId → JSONL path` resolution (incl. subagent open item) → Task 3 (Step 1 verifies the subagent convention before coding). ✓
- Client live-window cap → Task 1. ✓
- `event_count > events.length` for hasMore → Task 6 Step 1. ✓
- Shared backfill hook: fetch / merge / single-flight / scroll-anchor / clear-on-tail → Task 5 + Task 6 Step 2. ✓
- Integration across surfaces → Task 6 (PanelCard; expanded/TraceTab replication noted). ✓
- Testing (reducer, server, hook) → Tasks 1, 2, 4, 5; scroll-anchor is explicitly manual (jsdom has no layout). ✓
- Tunables `LIVE_WINDOW≈1500`, `HISTORY_PAGE≈500`, top-trigger≈200px → Tasks 1, 5. ✓

**Placeholder scan:** No "TBD"/"handle edge cases"-style steps; every code step shows code. Two steps (Task 3 Step 1, Task 4 Step 1 note) are genuine investigate-then-adjust steps with explicit commands and a rule against inventing paths/uuids — not placeholders.

**Type consistency:** `LIVE_WINDOW`/`EVICT_CHUNK` (Task 1) reused by name in tests; `sliceHistory(events, beforeUuid, limit) → {events, hasMore}` consistent across Tasks 2/4; `sourceFileForPanel(panelId): string | null` consistent across Tasks 3/4; `useScrollBackfill` arg/return shape consistent across Tasks 5/6 (`mergedEvents`, `reset`, `onScroll`).
