# Transforms inspector — Spec 3 of 3: Mode C (live trace + debug snapshot)

Date: 2026-06-08
Status: draft

> Part of a three-spec rebuild of `TransformsModal` into a real inspector.
> Spec 1 introduces the selector engine + `matches?: string[]` migration.
> Spec 2 builds the inspector modal shell with two tabs (event-types
> catalog, transform browser).
> **Spec 3** layers a third tab — live trace — onto that shell and adds
> runtime instrumentation to the pipeline runner. Specs 1, 2, and 3 share
> a verbatim seam (see "Shared seam" below) and are intended to be
> developable in parallel.

## Problem

The current `TransformsModal` is a flat list. When a transform fires
incorrectly — wrong event consumed, mutation didn't land where expected,
silent exception swallowed by the runner's try/catch — there is no way
to see what actually happened inside `preprocessEvents` for a particular
panel. You have to console.log the transform, rebuild, reload.

Spec 3 makes the pipeline self-describing at runtime: every pass
produces a structured trace, the inspector renders it, and a single
button copies a debug snapshot suitable for pasting into a Claude
conversation.

## Goals

- Instrument `runner.ts` to emit a `TraceRecord[]` for each
  `preprocessEvents` pass on a panel, keyed by `panelId`.
- Add **Tab C — Trace** to the Spec 2 modal: event list (left) + per-event
  detail (right) with filters.
- "Copy debug snapshot" button on a selected Event → Markdown-flavored
  clipboard dump (raw Event JSON + per-stage trace + resulting
  ViewItem(s) + toggle state).
- Per-transform enable/disable checkbox. Toggled-off transforms are
  skipped by the runner. State persists in `localStorage`, scoped per
  panel.

## Non-goals

- No persistent trace history (each render replaces the trace).
- No cross-panel trace aggregation.
- No sample capture / fixture versioning. Deferred.
- No raw-JSONL-line tracking. Trace operates on parsed `Event`s.
- No "diff this pass vs. last pass" view. Deferred.
- No editing transform source from the inspector.

## Shared seam (verbatim — must match Specs 1 and 2)

```ts
// transforms/selectors/types.ts
type Selector = { source: string; ast: SelectorNode; match: (e: Event) => boolean };

interface SelectorDef {
  key: string;
  name: string;
  description: string;
  selector: string;
  samplePayload?: unknown;
}

interface BaseTransform { /* existing fields */ matches?: string[]; }

// Spec 3 owns:
interface TraceRecord {
  eventUuid: string;
  perStage: Array<{
    transformKey: string;
    matched: boolean;       // selector matched (or no selector)
    ran: boolean;           // run() was invoked
    consumed: boolean;      // stage-1 returned true
    mutatedItems: boolean;  // heuristic — see "Mutation detection"
    error?: TransformError;
  }>;
  finalItemIndices: number[]; // indices into the post-pipeline items[]
}
```

## Runner instrumentation

### Hook site

Modify `client/src/transforms/runner.ts`'s stage-1 loop (Spec 1 will
have already refactored selector dispatch; this spec assumes that
landing). The relevant per-transform call becomes:

```ts
for (const event of events) {
  const record: TraceRecord = { eventUuid: event.uuid, perStage: [], finalItemIndices: [] };
  for (const t of stage1) {
    const matched = t.selector ? t.selector.match(event) : true;
    const enabled = toggles.isEnabled(t.key);
    if (!matched || !enabled) {
      if (tracing) record.perStage.push({ transformKey: t.key, matched, ran: false, consumed: false, mutatedItems: false });
      continue;
    }
    const before = snapshotItems(items);
    let consumed = false;
    let error: TransformError | undefined;
    try {
      consumed = t.run(event, items, ctx) === true;
    } catch (err) {
      error = toTransformError(err);
      console.error(`[transform ${t.key}] threw on event ${event.uuid}:`, err);
    }
    const mutatedItems = detectMutation(before, items);
    if (tracing) record.perStage.push({ transformKey: t.key, matched: true, ran: true, consumed, mutatedItems, error });
    if (consumed) break;
  }
  if (tracing) trace.push(record);
}
```

`finalItemIndices` is filled in after stage-2 completes by walking the
final `items` array and noting which entries carry an `anchorUuid` (or
equivalent) matching the record's `eventUuid`. Items that lost their
anchor through stage-2 coalescing get attributed to the last surviving
event they contain. This is best-effort — see "Open questions".

### Mutation detection

Cheap heuristic, in order:

1. `items.length` changed → mutated.
2. Last item's identity (`items[items.length - 1]` ref equality with
   pre-snapshot last item) changed → mutated.
3. Otherwise → assume not mutated. This misses in-place mutation of an
   existing item's interior (e.g. pushing into a coalesced
   `entries[]`). Acknowledged limitation; we surface it in the UI
   tooltip on the "mutated" indicator ("heuristic: detects length /
   tail-ref changes").

Snapshot is a 2-tuple `{ length, tailRef }` — O(1).

### Stage-2 instrumentation

Stage-2 transforms get a lighter trace: one record per stage-2
transform per pass, capturing `{ transformKey, ran, mutatedItems,
error, beforeLen, afterLen }`. Stored on the panel's trace object
alongside the per-event records. Tab C surfaces this as a small
"Stage 2" section under the event list, not in the per-event detail.

### Performance + gating

Instrumentation is gated by a `tracing: boolean` flag passed into
`runViewPipeline`. The flag is `true` only when:

- The inspector modal is open, AND
- The user has Tab C selected, OR has set "always trace" in a debug
  preference.

When `tracing` is `false`, the runner takes the existing fast path —
no `record` allocation, no per-stage push, no `snapshotItems`. The
toggle-skip check (cheap `Set.has`) always runs regardless.

Rationale: the pipeline runs on every render; we don't want trace
allocations in the steady-state cost path.

## TraceRecord storage

A React context (`TraceContext`) exposes a ref-backed map:

```ts
type PanelTrace = {
  perEvent: TraceRecord[];
  stage2: Stage2TraceRecord[];
  generatedAt: number;
};
const tracesByPanel = useRef<Map<string, PanelTrace>>(new Map());
```

`preprocessEvents` writes the current pass's trace into the map
keyed by `panelId` on every call when `tracing` is true. Entries are
not persisted across reloads. When a panel unmounts, its entry is
deleted.

The inspector subscribes via `useSyncExternalStore` so opening Tab C
on a panel whose events haven't changed shows the most recent trace
immediately (the first render with `tracing: true` populates it).

## Tab C — Trace UI

Two-pane layout, same overall structure as Tab B's
transform-detail split.

### Left pane: event list

Virtualized list (the same virtualizer Spec 2 uses for Tab A's event
catalog). Columns:

| col | content |
|-----|---------|
| # | event index in panel |
| kind | `event.kind` chip |
| tags | `event.tags` chips, truncated |
| preview | first ~60 chars of payload text (`text` field if present, else `JSON.stringify(payload).slice(0,60)`) |
| touched by | chips of `transformKey` for each stage with `ran: true`, dimmed if `consumed: false` |
| status | dot: green (consumed cleanly), amber (matched + ran but no mutation), red (errored), gray (no transform ran) |

Clicking a row selects it; the detail pane updates.

### Right pane: event detail

Sections, top to bottom:

1. **Header** — event UUID (monospace, click-to-copy), kind, tags, ts.
2. **Raw event** — collapsed JSON, expandable. Reuse Spec 2's JSON
   viewer.
3. **Stage 1 trace** — table:

   | transform | matched | ran | consumed | mutated | error |
   |-----------|---------|-----|----------|---------|-------|
   | userTextBubble | ✓ | ✓ | ✓ | ✓ | — |
   | bashTerminal | ✗ | — | — | — | — |
   | toolUseCapsule | (skipped: disabled) | — | — | — | — |

   Toggled-off transforms show grayed out with "(disabled)" label.
   Errored rows have the error message inline expandable.

4. **Resulting view items** — JSON of every `ViewItem` whose
   `finalItemIndices` includes this event. Each item gets a small
   header showing its `type` and (if present) `anchorUuid`.

5. **Copy debug snapshot** button — see below.

### Filter bar

Above the event list:

- Transform filter: multi-select of transform keys. Selecting "X"
  shows only events where any per-stage record has `transformKey: 'X'`
  and `ran: true`.
- Status filter: checkboxes for `consumed`, `errored`, `not-matched`
  (no stage ran).
- Free-text: substring match against the preview column.

Filters combine with AND. Clear-all link in the corner.

### Empty / closed states

- Inspector closed → `tracing` is false → no trace exists → no Tab C UI
  to render. (We don't build TraceRecords speculatively.)
- Inspector open on Tab A or B → `tracing` is false unless "always
  trace" preference is on. Switching to Tab C flips the flag, triggers
  a re-render of the panel's pipeline, and the trace populates on the
  next pass. Show a one-tick "tracing…" spinner.
- Panel has zero events → "Nothing to trace yet" with a hint about
  what's logged.

## Debug snapshot format

Strawman — Markdown-flavored, copy-paste friendly, structured so a
future Claude conversation can locate each section by heading.

```md
# brainhouse pipeline snapshot

panel: `p_8f3a…`
event: `e_b1c2…`  (index 47 of 213)
captured: 2026-06-08T14:22:11Z
runner: v2 (selector dispatch)

## Raw event

```json
{ "uuid": "e_b1c2…", "kind": "user_text", "tags": ["btw"], "ts": "…", "payload": { … } }
```

## Stage 1 trace

| transform | matched | ran | consumed | mutated | error |
|-----------|:-:|:-:|:-:|:-:|:--|
| stripBhTitleMarker | ✓ | ✓ |   | ✓ |   |
| tagBtwUserText     | ✓ | ✓ |   | ✓ |   |
| bashTerminal       |   |   |   |   |   |
| userTextBubble     | ✓ | ✓ | ✓ | ✓ |   |

(disabled: `toolUseCapsule`, `subagentBanner`)

## Stage 2 trace

| transform | mutated | beforeLen → afterLen | error |
|-----------|:-:|:-:|:--|
| coalesceAdjacentBubbles | ✓ | 214 → 211 |   |

## Resulting view items

```json
[
  { "type": "user_bubble", "anchorUuid": "e_b1c2…", "text": "…" }
]
```

## Toggles (panel-local)

enabled: stripBhTitleMarker, tagBtwUserText, bashTerminal, userTextBubble, coalesceAdjacentBubbles
disabled: toolUseCapsule, subagentBanner
```

The button writes this to the clipboard via `navigator.clipboard.writeText`
and shows a small "copied" pill. A second action ("Copy as JSON")
emits the same data as a single JSON object for programmatic use.

## Per-transform toggle

### State

```ts
type ToggleMap = Record<string /* transformKey */, boolean>;
```

`localStorage` key: `bh.transforms.toggles.v1:${panelId}`. Default for
unknown keys is `true`. A small migration helper handles missing-key
reads.

A `useTransformToggles(panelId)` hook returns `{ isEnabled, set,
all }`. The runner receives the `isEnabled` function via context.

### UI surface

- **Tab B (Spec 2)** gains a leftmost column on the transform list:
  a small checkbox. Hover tooltip: "Disable on this panel". Disabled
  rows render with reduced opacity but remain selectable.
- **Tab C** shows the same disabled state in the per-event stage
  table (grayed row, "(disabled)" label) and in the snapshot's
  toggles section.
- A "Reset toggles" link in the modal footer when at least one
  transform is disabled on the current panel.

### Runner interaction

Spec 1's selector dispatch must check `isEnabled(t.key)` *before*
selector match (cheap reject). A toggled-off transform is treated
exactly as if it weren't in the registry: no selector evaluation,
no run, no trace row except a single "skipped: disabled" marker
when tracing.

## Integration with Spec 2

| concern | spec 2 | spec 3 |
|---------|--------|--------|
| Modal shell, tab strip, virtualizer | owns | reuses |
| Tab A (event catalog) | owns | — |
| Tab B (transform browser) layout | owns | adds Toggle column |
| Tab C (trace) | placeholder file | owns implementation |
| `TraceContext` + provider mount | — | owns |
| `tracing` flag plumbing into `runViewPipeline` | — | owns |
| Toggle hook + localStorage | — | owns; Spec 2 imports the hook for the checkbox column |

Spec 2 lands first with a stubbed Tab C ("Trace — coming in Spec 3").
Spec 3 fills in the tab and adds the toggle column without changing
Spec 2's tab framework.

## Testing

### Runner instrumentation

`client/src/transforms/runner.test.ts` (new file):

1. Fixture event stream of 5 events, 3 stage-1 transforms with known
   selectors. Assert each `TraceRecord.perStage` matches the expected
   match/ran/consumed flags.
2. A transform that throws on a specific event → its trace row has
   `error` populated and `consumed: false`; subsequent transforms
   still get a chance to run on that event.
3. `tracing: false` → return value identical to `tracing: true` (modulo
   the trace itself), and no allocations measurable via a counter on
   a test-only `snapshotItems` spy.
4. Toggled-off transform → no `run()` call, single `{ matched: false,
   ran: false }` trace row when tracing.
5. Mutation detection: a transform that pushes a new item → `mutatedItems:
   true`. A no-op transform → `mutatedItems: false`. A transform that
   mutates `items[k].entries` in place without changing length or tail
   ref → `mutatedItems: false` (documents the heuristic's limitation).

### Stage-2 trace

6. Stage-2 transform that shrinks `items` → trace row records
   `beforeLen > afterLen`, `mutatedItems: true`.

### Tab C component

Storybook story (or test) covering:

- Event list with 100 fake events, virtualizer renders.
- Detail pane for an event with errors → red row, expandable message.
- Filter by transform key → list narrows correctly.
- Empty state when zero events.

### Snapshot format

Pure-function test on the snapshot serializer: given a fixture
`TraceRecord` + event + items + toggles, the output string matches a
golden file (`__fixtures__/snapshot.golden.md`). Easier to diff than
asserting on substrings.

### Toggle persistence

Test that disabling a transform on panel A doesn't disable it on panel
B; that disabled transforms survive a reload (localStorage hit); that
the runner skips disabled transforms.

## Open questions

- **`finalItemIndices` attribution.** Stage-2 coalescing can merge
  multiple events into one item. The current heuristic (match by
  `anchorUuid`, fall back to last surviving event) is best-effort.
  Should we make stage-2 transforms declare a `contributors: Event[]`
  on items they emit, to get exact attribution? Probably yes
  eventually; out of scope for v1.
- **Mutation detection of in-place edits.** If this proves a
  recurring source of confusion ("transform X clearly ran but
  inspector says it didn't mutate"), we'd add an opt-in API for
  transforms to declare a mutation via the context. Defer until we
  see it bite.
- **Stage-2 errors and partial results.** Today's runner catches and
  drops the stage-2 mutation on error. The trace records the error;
  do we want to also snapshot the pre-error `items` for inspection?
  Probably yes — cheap, and the failure case is exactly when you
  want to see it. Add to v1 if cost is low.
- **Snapshot format stability.** Once external Claude conversations
  start consuming the snapshot, the format is effectively an API.
  Version it (`runner: v2` line) from day one so we can evolve it.
- **"Always trace" preference.** Useful for dogfooding but bypasses
  the performance gate. Keep it behind a debug menu, not the main
  inspector toggle.
