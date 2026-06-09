# Transforms inspector — Spec 3 (live trace + debug snapshot) implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add runtime instrumentation to the view-pipeline runner, expose a Trace tab in `TransformsModal`, and ship a per-panel transform toggle (with localStorage persistence and a Markdown debug-snapshot serializer).

**Architecture:** Instrument `runner.ts` with an optional `trace` accumulator + an `isEnabled` predicate, both gated so the no-trace fast path stays allocation-free. Trace storage lives in a React `TraceContext` keyed by `panelId`. Toggle state is a `useTransformToggles(panelId)` hook backed by `localStorage`. UI: a second tab in the existing modal (until Spec 2 lands), self-contained in `TraceTab.tsx`, with a pure-function snapshot serializer covered by a golden test.

**Tech Stack:** React 19, Vitest, TypeScript. CSS classes only (no inline styles).

**Specs 1 / 2 integration:** the real `firstSelectorHit` (Spec 1) and the tabbed modal shell (Spec 2) don't exist yet. We stub `firstSelectorHit` locally and embed the Trace tab in the existing single-panel modal via a small inline tab strip. When Spec 2 merges, they import our `useTransformToggles` and replace our tab strip with theirs; when Spec 1 merges, the stub is swapped for the real selector lookup.

---

## File structure

Create:
- `client/src/transforms/runner.test.ts` — TDD coverage for the instrumented runner
- `client/src/transforms/traceContext.tsx` — React `TraceContext` + provider + `useTrace`
- `client/src/transforms/useTransformToggles.ts` — per-panel toggle hook (localStorage)
- `client/src/transforms/useTransformToggles.test.ts`
- `client/src/transforms/snapshot.ts` — pure-function Markdown serializer
- `client/src/transforms/snapshot.test.ts`
- `client/src/transforms/__fixtures__/snapshot.golden.md`
- `client/src/components/TraceTab.tsx`

Modify:
- `client/src/transforms/runner.ts` — accept `RunViewPipelineOpts.trace` + `isEnabled`
- `client/src/lib/pipeline.ts` — forward optional `trace` + `isEnabled` from caller
- `client/src/components/TransformsModal.tsx` — add an internal Pipeline / Trace tab strip; embed `TraceTab`
- `client/src/components/TransformsModal.test.tsx` — keep the existing list assertions; the tabs are additive
- `client/src/app.css` — minimal classes for the tab strip + trace tables

---

## Task 1 — runner instrumentation (TDD)

**Files:**
- Create: `client/src/transforms/runner.test.ts`
- Modify: `client/src/transforms/runner.ts`

Goal: extend `runViewPipeline` so callers can pass `trace?: { perEvent: TraceRecord[]; stage2: Stage2TraceRecord[] }` and `isEnabled?: (key: string) => boolean`. When `trace` is undefined the runner stays on the existing fast path.

Steps:

- [ ] Add (in `runner.ts`) the local stub:
  ```ts
  // Until Spec 1 lands its selector engine, transforms can't declare
  // `matches` meaningfully. The stub returns 'any' when no matches are
  // declared and null otherwise (no transform currently sets matches).
  function firstSelectorHit(matches: string[] | undefined, _event: Event): 'any' | string | null {
    if (!matches || matches.length === 0) return 'any';
    return null;
  }
  ```
- [ ] Add `Stage2TraceRecord` type:
  ```ts
  export interface Stage2TraceRecord {
    transformKey: string;
    ran: boolean;
    mutatedItems: boolean;
    beforeLen: number;
    afterLen: number;
    error?: TransformError;
  }
  ```
- [ ] Add `TraceAccumulator`:
  ```ts
  export interface TraceAccumulator {
    perEvent: TraceRecord[];
    stage2: Stage2TraceRecord[];
  }
  ```
- [ ] Extend `RunViewPipelineOpts`:
  ```ts
  trace?: TraceAccumulator;
  isEnabled?: (transformKey: string) => boolean;
  ```
- [ ] Mutation detection helper:
  ```ts
  function snapshotItems(items: ViewItem[]): { length: number; tailRef: ViewItem | null } {
    return { length: items.length, tailRef: items.length > 0 ? items[items.length - 1]! : null };
  }
  function detectMutation(before: { length: number; tailRef: ViewItem | null }, items: ViewItem[]): boolean {
    if (items.length !== before.length) return true;
    if (items.length === 0) return false;
    return items[items.length - 1] !== before.tailRef;
  }
  ```
- [ ] Per-event loop becomes:
  ```ts
  const isEnabled = opts.isEnabled;
  const tracing = !!opts.trace;
  for (const event of events) {
    const record: TraceRecord | null = tracing
      ? { eventUuid: event.uuid, perStage: [], finalItemIndices: [] }
      : null;
    for (const t of stage1) {
      const enabled = isEnabled ? isEnabled(t.key) : true;
      const matchHit = firstSelectorHit(t.matches, event);
      const matched = matchHit !== null;
      if (!enabled) {
        if (record) record.perStage.push({
          transformKey: t.key, matched, ran: false, consumed: false, mutatedItems: false,
        });
        continue;
      }
      if (!matched) {
        if (record) record.perStage.push({
          transformKey: t.key, matched: false, ran: false, consumed: false, mutatedItems: false,
        });
        continue;
      }
      const before = record ? snapshotItems(items) : null;
      let consumed = false;
      let error: TransformError | undefined;
      try {
        consumed = t.run(event, items, ctx) === true;
      } catch (err) {
        error = { transformKey: t.key, message: err instanceof Error ? err.message : String(err), eventUuid: event.uuid, ts: Date.now() };
        console.error(`[transform ${t.key}] threw on event ${event.uuid}:`, err);
      }
      if (record && before) {
        const mutated = detectMutation(before, items);
        record.perStage.push({
          transformKey: t.key,
          selectorKey: matchHit === 'any' ? undefined : matchHit ?? undefined,
          matched: true, ran: true, consumed, mutatedItems: mutated, error,
        });
      }
      if (consumed) break;
    }
    if (record) opts.trace!.perEvent.push(record);
  }
  ```
- [ ] Stage-2 loop becomes:
  ```ts
  for (const t of stage2) {
    const enabled = isEnabled ? isEnabled(t.key) : true;
    if (!enabled) {
      if (opts.trace) opts.trace.stage2.push({ transformKey: t.key, ran: false, mutatedItems: false, beforeLen: items.length, afterLen: items.length });
      continue;
    }
    const beforeLen = items.length;
    let mutated = false;
    let error: TransformError | undefined;
    try {
      const next = t.run(items, ctx);
      mutated = next !== items || next.length !== beforeLen;
      items = next;
    } catch (err) {
      error = { transformKey: t.key, message: err instanceof Error ? err.message : String(err), ts: Date.now() };
      console.error(`[transform ${t.key}] threw in stage-2 pass:`, err);
    }
    if (opts.trace) opts.trace.stage2.push({
      transformKey: t.key, ran: true, mutatedItems: mutated, beforeLen, afterLen: items.length, error,
    });
  }
  ```
- [ ] After stage 2, attribute final items:
  ```ts
  if (opts.trace) {
    const indexByUuid = new Map<string, number[]>();
    items.forEach((it, idx) => {
      const uuid = (it as { anchorUuid?: string; event?: { uuid?: string } }).anchorUuid
        ?? (it as { event?: { uuid?: string } }).event?.uuid;
      if (!uuid) return;
      const arr = indexByUuid.get(uuid) ?? [];
      arr.push(idx);
      indexByUuid.set(uuid, arr);
    });
    for (const rec of opts.trace.perEvent) {
      const idxs = indexByUuid.get(rec.eventUuid);
      if (idxs) rec.finalItemIndices = idxs;
    }
  }
  ```

Tests (`runner.test.ts`) — write each, see it fail, then implement / adjust:

- [ ] **fast path: no trace allocation** — call `runViewPipeline(events)` (no trace), assert the return shape matches and that `runViewPipeline(events, { trace })` returns the same items list.
- [ ] **per-event records** — single user_text event; assert one record with one `perStage` entry per stage-1 transform, ending with the first that consumed (entries after the consumer omitted because we `break`).
- [ ] **error capture** — inject a stage-1 transform that throws; assert the record's `error` is populated, `consumed: false`, and the next event still processes cleanly.
- [ ] **toggle off** — pass `isEnabled: (k) => k !== 'userTextBubble'`; with a single user_text event, assert that transform's record has `ran: false` and that no bubble was emitted.
- [ ] **mutation heuristic** — a stage-1 transform that pushes a fresh item → `mutatedItems: true`. A pass-through transform → `mutatedItems: false`. Document with a comment that in-place mutation of `items[k].entries` isn't detected.
- [ ] **stage-2 shrink** — feed events that produce coalescing; assert `stage2[i].beforeLen > stage2[i].afterLen` and `mutatedItems: true`.
- [ ] **finalItemIndices attribution** — event whose uuid ends up as `anchorUuid` of one item; assert `record.finalItemIndices = [idx]`.

Commit after green:
```
client/transforms: instrument runner with trace + toggle hooks
```

---

## Task 2 — `useTransformToggles` hook

**Files:**
- Create: `client/src/transforms/useTransformToggles.ts`
- Create: `client/src/transforms/useTransformToggles.test.ts`

Shape:
```ts
export interface TransformToggles {
  isEnabled: (key: string) => boolean;
  set: (key: string, enabled: boolean) => void;
  all: Record<string, boolean>;
  resetAll: () => void;
}
export function useTransformToggles(panelId: string): TransformToggles { ... }
```

- localStorage key: `bh.transforms.toggles.v1:${panelId}`.
- Default for unknown keys: `true`.
- Persist on every `set`. Use `useSyncExternalStore` so multiple panels stay coherent.
- Implementation note: keep an in-module `Map<panelId, Record<key, boolean>>` cache + a per-panel subscriber set, hydrated lazily from localStorage on first read.

Tests:
- [ ] unknown key → `isEnabled` returns `true`
- [ ] `set('foo', false)` then `isEnabled('foo')` → `false`
- [ ] persisted across hook unmount/remount (same panelId)
- [ ] disabling on panel A doesn't affect panel B
- [ ] `resetAll` returns everything to enabled and clears localStorage entry

Commit:
```
client/transforms: per-panel transform toggle hook
```

---

## Task 3 — `TraceContext`

**Files:**
- Create: `client/src/transforms/traceContext.tsx`

Shape:
```ts
export interface PanelTrace {
  perEvent: TraceRecord[];
  stage2: Stage2TraceRecord[];
  generatedAt: number;
}
export interface TraceStore {
  get(panelId: string): PanelTrace | undefined;
  write(panelId: string, trace: PanelTrace): void;
  clear(panelId: string): void;
  subscribe(panelId: string, fn: () => void): () => void;
  isTracing(panelId: string): boolean;
  setTracing(panelId: string, on: boolean): void;
}
export function useTraceStore(): TraceStore;
export function useTracingFlag(panelId: string): boolean;
export function usePanelTrace(panelId: string): PanelTrace | undefined;
export const TraceProvider: FC<{ children: ReactNode }>;
```

Implementation: a module-scoped singleton store (Map + listener sets) wrapped by a React context that returns the singleton. `useSyncExternalStore` for `usePanelTrace` and `useTracingFlag`.

No tests in this step (it's plumbing; covered indirectly by Task 5). Commit:
```
client/transforms: trace context + per-panel store
```

---

## Task 4 — snapshot serializer (golden test)

**Files:**
- Create: `client/src/transforms/snapshot.ts`
- Create: `client/src/transforms/snapshot.test.ts`
- Create: `client/src/transforms/__fixtures__/snapshot.golden.md`

Shape:
```ts
export interface SnapshotInput {
  panelId: string;
  event: Event;
  eventIndex: number;
  eventTotal: number;
  capturedAt: Date;
  record: TraceRecord;
  stage2: Stage2TraceRecord[];
  items: ViewItem[];
  toggles: Record<string, boolean>;
  runnerVersion?: string;
}
export function serializeDebugSnapshot(input: SnapshotInput): string;
export function serializeDebugSnapshotJson(input: SnapshotInput): string;
```

Markdown format follows Spec 3 §"Debug snapshot format" exactly. Steps:

- [ ] Write `snapshot.test.ts` with a fixture: hand-build a `SnapshotInput`, compare the function output byte-for-byte against the golden file (read with `fs.readFileSync`).
- [ ] Run test → fail (no golden, no implementation).
- [ ] Implement `serializeDebugSnapshot`. Use a fixed UTC ISO string for `capturedAt` to keep determinism.
- [ ] Hand-author the golden file from the spec template (no emojis; verbatim section headings).
- [ ] Add JSON variant test (parses, has expected keys).

Commit:
```
client/transforms: debug-snapshot serializer + golden test
```

---

## Task 5 — wire pipeline + components together

**Files:**
- Modify: `client/src/lib/pipeline.ts`
- Modify: `client/src/components/EventList.tsx` and/or `client/src/components/PanelCard.tsx`

Steps:

- [ ] `preprocessEvents` gains optional `trace` + `isEnabled` in `PreprocessOpts`, forwarded directly to `runViewPipeline`. Existing callers pass nothing → identical behavior; pipeline golden test stays byte-equal.
- [ ] In `EventList.tsx` (and the PanelCard call path), add an optional `panelId` prop. When present: read `useTracingFlag(panelId)` + `useTransformToggles(panelId)`, build a `trace` accumulator when tracing, call `preprocessEvents(events, { view, trace, isEnabled })`, then `traceStore.write(panelId, { ...trace, generatedAt: Date.now() })` after the call (inside `useMemo`/`useEffect`). When `panelId` absent, keep the current zero-allocation call.
- [ ] Plumb `panelId` from `PanelCard`'s caller. (Use `panel.id`.)
- [ ] Mount `<TraceProvider>` at the app root in `App.tsx`.

No new tests here — the existing `pipeline.test.ts` is the regression guardrail.

Commit:
```
client: thread trace + toggles into pipeline call sites
```

---

## Task 6 — Trace tab UI

**Files:**
- Create: `client/src/components/TraceTab.tsx`
- Modify: `client/src/components/TransformsModal.tsx`
- Modify: `client/src/app.css`

Steps:

- [ ] Refactor `TransformsModal` to take an optional `panelId` prop and render an inline two-tab strip (`Pipeline` / `Trace`). When `panelId` is undefined, hide the Trace tab — the existing list view stays the default. Existing tests still pass because the `.transforms-item` markup for the Pipeline tab is unchanged.
- [ ] In `App.tsx`, pass the active panel id into the modal (the trigger lives in the per-panel debug cluster). When opened from outside a panel context, no `panelId` → no Trace tab.
- [ ] On Trace tab mount, call `traceStore.setTracing(panelId, true)`; on unmount, `setTracing(panelId, false)`. This triggers a re-render of the panel's pipeline via the existing prop chain (because `useTracingFlag(panelId)` flips).
- [ ] `TraceTab` layout (CSS classes only — no inline styles):
  - Left pane: simple non-virtualized event list (virtualizer is Spec 2's; we punt). Columns: `#`, kind, tags, preview, touched-by chips, status dot.
  - Filter bar above the list: free-text input + transform multi-select + status checkboxes. Filter logic is plain `Array.filter`.
  - Right pane: header (uuid copy button), raw event JSON in `<details>`, stage-1 table, stage-2 table, resulting view items JSON, "Copy debug snapshot" + "Copy as JSON" buttons.
  - Toggled-off transforms render with `.trace-row-disabled` class.
- [ ] Add a "Reset toggles" link in the modal footer (only visible when `Object.values(toggles.all).some(v => !v)`).
- [ ] Snapshot buttons call `navigator.clipboard.writeText(serializeDebugSnapshot(...))` and surface a `.snapshot-copied` pill that auto-hides after ~1.5 s.

- [ ] Add CSS to `app.css` (append a block near the existing `.transforms-*` classes). Required new classes (illustrative):
  ```
  .transforms-tab-strip, .transforms-tab, .transforms-tab.is-active,
  .trace-tab, .trace-event-list, .trace-row, .trace-row-disabled,
  .trace-status-dot.is-consumed, .is-errored, .is-noop, .is-skipped,
  .trace-detail-pane, .trace-stage-table, .snapshot-copied,
  .trace-filter-bar, .trace-reset-toggles
  ```
  Use existing tokens (`var(--card-bg)`, `var(--muted)`, etc.) so colors fit. Reuse `.lightbox-text-content` for JSON blobs where it fits.

- [ ] Update `TransformsModal.test.tsx`: add a test that asserts the Pipeline tab still renders the registry list (existing assertions unchanged), and that `<TransformsModal panelId="p1" />` renders a `Trace` tab control.

Commit:
```
client: add Trace tab to TransformsModal (panel-scoped)
```

---

## Task 7 — final verification

- [ ] Run `npm run typecheck` (from the repo root or each workspace as appropriate). Expect clean.
- [ ] Run `npm test`. Expect all suites green; `client/src/lib/pipeline.test.ts` unchanged.
- [ ] Run `npm run build`. Expect success.
- [ ] If any of the above fails, fix in-place; do not amend prior commits (per repo policy create new commits).

Commit (only if there were verification-driven fixes):
```
client/transforms: verification fixups
```

---

## Self-review checklist

- Runner instrumentation matches spec pseudocode (stub for `firstSelectorHit`, mutation heuristic, finalItemIndices attribution).
- `tracing` gate keeps fast path allocation-free (`record === null`, no `snapshotItems` call).
- Toggle hook key format `bh.transforms.toggles.v1:${panelId}`, default `true`.
- Snapshot serializer is pure + covered by a byte-equal golden test.
- No inline styles, no `!important`, no emojis in code or docs files.
- No new public API surface that touches `@internal` types.
