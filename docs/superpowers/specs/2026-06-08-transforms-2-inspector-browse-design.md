# Transforms inspector — Spec 2 of 3: modes A + B (static browse)

Date: 2026-06-08
Status: draft

## Context

Today `client/src/components/TransformsModal.tsx` is a ~30-line static list
of `VIEW_TRANSFORMS`. We're rebuilding it as a real inspector that lets a
developer browse the named event shapes the pipeline recognizes ("types"),
browse the transforms themselves with their declared match rules, and (in
a follow-up spec) watch a live trace of which transforms fired against
which events.

The work is split across three specs that can be developed in parallel:

1. **Spec 1** — Selector engine + migration. Adds `SELECTORS: SelectorDef[]`,
   a parser, and `matches?: string[]` on `BaseTransform`. Migrates the
   in-source `event.kind === ...` checks to declared match keys.
2. **Spec 2 (this one)** — Inspector modes A (Types) + B (Transforms).
3. **Spec 3** — Inspector mode C (live trace) + a debug snapshot export.

This spec reads `SelectorDef[]` and the existing `VIEW_TRANSFORMS` registry
and produces a UI. It does not depend on Spec 3. It can be built against a
mocked `SELECTORS` registry while Spec 1 is in flight.

## Shared seam (verbatim — must match Specs 1 and 3)

```ts
// client/src/transforms/selectors/types.ts
type Selector = { source: string; ast: SelectorNode; match: (e: Event) => boolean };

interface SelectorDef {
  key: string;            // stable id, e.g. "tool-use.todowrite"
  name: string;           // display name, e.g. "TodoWrite tool_use"
  description: string;
  selector: string;       // source string the engine parses
  samplePayload?: unknown;
}

// BaseTransform gains: matches?: string[]    // SelectorDef.key list
```

Spec 2 only reads these. It does not touch the engine.

## Goals

- Replace `TransformsModal.tsx` with a tabbed inspector.
- Tab A ("Types") — browse the catalog of named selectors. Author new
  selectors via point-and-build or raw text.
- Tab B ("Transforms") — browse registered transforms with their declared
  match keys (chips that cross-link to Tab A) and a read-only structural
  source view.
- A stubbed third tab ("Trace") whose body Spec 3 fills in.

## Non-goals

- Live trace recording / replay (Spec 3).
- Editing transform source. Source view is strictly read-only.
- Persistence of user-authored selectors. v1 is in-memory only; the
  catalog resets on refresh. Persistence has its own future spec.
- Per-panel toggle/reorder of transforms.
- A "preview" mode that shows what the pipeline would emit if a transform
  were disabled.

## Modal layout

The inspector replaces the body of `TransformsModal`. Outer machinery
(lightbox open/close, "T" hotkey wiring, title bar) is unchanged; only
the inner content is rebuilt.

```
┌ Pipeline inspector ────────────────────────────────────┐
│ [ Types ] [ Transforms ] [ Trace (Spec 3) ]            │
│ ─────────────────────────────────────────────────────  │
│ ┌────────────────┬───────────────────────────────────┐ │
│ │ list / search  │ detail panel                      │ │
│ │                │                                   │ │
│ └────────────────┴───────────────────────────────────┘ │
└────────────────────────────────────────────────────────┘
```

Two-column master/detail per tab. The list column owns search + selection;
the detail column owns rendering for the focused row. Selection lives in
URL hash state on the modal (`#inspector/types/<key>`,
`#inspector/transforms/<key>`) so a deep-link from a transform detail
chip to a type detail back is just a hash change.

The Trace tab renders a placeholder card ("Live trace — coming in Spec 3")
in v1; the tab itself is present so the visual rhythm doesn't shift when
Spec 3 lands.

Reuse styling primitives from `StatsModal` / `FlowsModal` / `ScenariosModal`
where possible — they already share modal-body conventions (header,
section dividers, hover-row treatment).

## Tab A — Types

### List

Columns: name · key · description (truncated). One row per `SelectorDef`,
sorted by key.

Header: search box + "Add type" button.

Search filters the list across:

- `name` (case-insensitive substring)
- `key` (case-insensitive substring)
- `selector` source string (case-insensitive substring)
- `description` (case-insensitive substring)

The filter is a single text input; the user gets all four matched in a
single pass. No advanced query syntax in v1.

A small badge marks user-authored entries (`origin: 'user'`) to distinguish
them from built-ins.

### Detail panel

Fields displayed:

- **Name** (large) + **key** (mono, small).
- **Description**.
- **Selector source** in a `<code>` block, syntax-highlighted with the
  same primitive used by Tab B's source view (see "Source rendering"
  below — kept consistent so two highlight engines don't need to coexist).
- **Sample payload**: `samplePayload` pretty-printed with
  `JSON.stringify(..., null, 2)` inside a `<pre>`. v1 is plain
  pretty-print; no collapsible tree. If a payload is missing, render a
  muted "(no sample payload)" line and a hint that one can be attached
  during point-and-build authoring.
- **Used by**: chips for every transform whose `matches` includes this
  key. Each chip is a button that navigates to the Transforms tab with
  that transform selected. Empty list renders "(no transform declares
  this type)".

### Authoring: point-and-build

"Add type" opens an in-modal sheet (overlays the detail panel; cancel
returns to list). The sheet has two entry paths:

**Pick-an-event.** A dropdown enumerates events from the currently focused
panel's event stream — most recent first, capped at ~200, each rendered
as `kind · summary · uuid-prefix`. Selecting one populates the workbench.

**Paste JSON.** A textarea where the user pastes an Event JSON. Validated
with the same parser the runtime uses (`server/src/parser.ts` is server-
side; the modal calls a thin client-side wrapper or the raw shape check —
TBD during impl, see Open questions).

Once an event is chosen, the workbench shows:

- The event JSON, pretty-printed, read-only.
- A **draft selector** the inference algorithm produced (see below),
  editable in a text input.
- A live "Matches sample? **yes** / **no**" indicator driven by
  `selector.match(event)`.
- Editable name, key, description fields. Key auto-suggests as
  `user.<slugified-name>` but can be overridden.
- Save / Cancel.

Save appends the new `SelectorDef` to the in-memory user layer (see
"Selector store"). The new entry appears in the list immediately with
the user-authored badge.

### Inference algorithm sketch

Given an event `e`, produce a draft selector string. v1 uses a simple
structural walk; the goal is "right often enough that the user only has
to edit, not write from scratch."

```
infer(e):
  parts = []
  parts.push(`event[kind=${e.kind}]`)
  switch e.kind:
    case 'tool_use':
      if e.payload.name: parts.push(`tool_use[name=${e.payload.name}]`)
    case 'tool_result':
      if e.payload.tool_use_id: parts.push('tool_result')  // id varies per event
    case 'user_text':
    case 'assistant_text':
      // look for distinctive XML-ish markers in the body
      for tag in ['bash-input', 'bh-title', 'task-notification',
                  'brainhouse-checklist']:
        if e.payload.text?.includes(`<${tag}`):
          parts.push(`text[contains=<${tag}]`)
          break
    case 'meta':
      if e.payload.kind: parts.push(`meta[kind=${e.payload.kind}]`)
  return parts.join(' > ')
```

The exact AST grammar is owned by Spec 1; this spec assumes the engine
can parse what `infer()` emits. If it can't, the inference output is
treated as a hint — the user can rewrite freely in the text field.

### Raw-selector escape hatch

A second tab inside the authoring sheet ("Write selector") skips the
event-driven path: just name, key, description, selector text, optional
attached sample event. Validated by trying to parse the selector source;
errors render inline.

## Tab B — Transforms

### List

One row per `VIEW_TRANSFORMS` entry. Columns:

- name
- key (mono)
- stage badge (`stage 1` / `stage 2`)
- views (`conversation`, `timeline`, or "all")
- declared match chips (compact, max 2 visible + "+N more")
- description (truncated to one line)

Sorted by registration order (matters — the order is semantically
meaningful, first-match-wins for stage 1).

Search: case-insensitive substring across name, key, description, and
the selector keys in `matches`.

### Detail panel

- **Name** + **key**.
- **Stage**, **views**, **description**.
- **Matches**: every selector key from `transform.matches` rendered as a
  chip that navigates to Tab A with that type selected. If
  `matches === undefined`, render "(no declared match — runs against
  every event)" with a muted treatment.
- **Source**: read-only view of the transform's TypeScript source.

### Source rendering

Source is loaded at build time using Vite's `?raw` import suffix. We
maintain a small manifest mapping each transform key to its module path:

```ts
// client/src/components/transforms-inspector/sources.ts
import bashTerminalSrc from '../../transforms/builtIn/bashTerminal.ts?raw';
// ...one line per transform
export const TRANSFORM_SOURCE: Record<string, string> = {
  bashTerminal: bashTerminalSrc,
  // ...
};
```

Adding a new transform requires one line here. A unit test asserts
`Object.keys(TRANSFORM_SOURCE)` equals `VIEW_TRANSFORMS.map(t => t.key)`
so the manifest can't drift silently.

Highlighting: a lightweight TS highlighter. Acceptable v1 options:

- `shiki` if it's already in the bundle (check at impl time).
- A regex tokenizer (keywords / strings / comments / identifiers).
- Plain `<pre>` with no highlight if both are too heavy.

Pick the lightest that already exists or that adds < 50KB gz. Decision
deferred to impl.

**Outline.** A small structural index sits above the source block:

- function signature(s) at the top level (`run(event, items, ctx)` etc.)
- top-level `if` / `switch` branch labels (first line of each branch).

A regex-based outliner is sufficient — anchor on `^(export )?(function|const)\s+\w+` for declarations and `^\s{2}(if|switch|case|else if)\b` inside `run` bodies. No TypeScript compiler API.

Clicking an outline entry scrolls the source block to that line.

## Selector store

A React context provides the union of built-in + user-authored selectors:

```ts
// client/src/transforms/selectors/store.tsx
type SelectorOrigin = 'builtin' | 'user';
type StoredSelectorDef = SelectorDef & { origin: SelectorOrigin };

interface SelectorStore {
  all: StoredSelectorDef[];
  byKey: Map<string, StoredSelectorDef>;
  addUser(def: SelectorDef): void;            // appends, in-memory
  removeUser(key: string): void;              // only for origin === 'user'
}

export function useSelectors(): SelectorStore;
```

Provider sits in `App.tsx` so the inspector and any future consumer
share one store. User-added entries are kept in component state — no
localStorage in v1.

Key collision rule: user entries are namespaced (key must start with
`user.`); if a user enters a key that collides with a built-in, save
is rejected with an inline error.

## Mocking strategy for parallel dev

While Spec 1 is unmerged, Spec 2 ships with a mock:

```ts
// client/src/transforms/selectors/mock.ts
export const MOCK_SELECTORS: SelectorDef[] = [
  { key: 'tool-use.todowrite', name: 'TodoWrite tool_use', ... },
  { key: 'user-text.bash', name: 'Bash-tagged user_text', ... },
  // a handful that exercise the UI: short list, long list,
  // missing-sample case, multi-transform case.
];
export const mockMatcher = (_e: unknown) => false;
```

The store imports from `selectors/index.ts` which re-exports either the
mock or the real engine. Cutover when Spec 1 lands is a one-line change
to that barrel. Tab B's `matches` chips also need to work against
mock keys — every `VIEW_TRANSFORMS` entry's `matches` is `undefined` in
the pre-Spec-1 world, so chips render "(no declared match)" until the
selector migration completes.

## Component breakdown

Under `client/src/components/transforms-inspector/`:

- `TransformsInspector.tsx` — top-level. Tab strip + body. Replaces the
  body of `TransformsModal.tsx` (the modal shell stays).
- `TypesTab.tsx` — Tab A controller. Owns search + selection state.
- `TypesList.tsx` — left column.
- `TypesDetail.tsx` — right column.
- `TypeAuthoringSheet.tsx` — point-and-build + raw-selector sheet.
- `inference.ts` — `infer(event): string`. Pure, unit-testable.
- `TransformsTab.tsx` — Tab B controller.
- `TransformsList.tsx` — left column.
- `TransformsDetail.tsx` — right column.
- `SourceView.tsx` — read-only source block with outline.
- `sources.ts` — `?raw` manifest.
- `outline.ts` — regex outliner. Pure, unit-testable.
- `chips.tsx` — shared chip component for selector keys (so Tab A and
  Tab B render them identically).

Top-level `TransformsModal.tsx` becomes a thin wrapper:

```tsx
export function TransformsModal() {
  return (
    <div className="transforms-modal">
      <h3 className="lightbox-title">Pipeline inspector</h3>
      <TransformsInspector />
    </div>
  );
}
```

## Testing

Stories (`*.stories.tsx`):

- `TransformsInspector.stories.tsx` — default (Types tab), Transforms
  tab, Trace tab placeholder.
- `TypesDetail.stories.tsx` — with-sample, without-sample,
  many-related-transforms, no-related-transforms.
- `TypeAuthoringSheet.stories.tsx` — pick-an-event flow, paste-JSON
  flow, raw-selector flow, save-error (key collision).
- `TransformsDetail.stories.tsx` — stage-1 with matches, stage-2
  without matches, long-source.
- `SourceView.stories.tsx` — short, long, outline-with-many-branches.

Unit tests:

- `inference.test.ts` — covers each event-kind branch, plus an unknown
  kind (should fall back to `event[kind=<x>]`).
- `outline.test.ts` — recognizes function signatures, top-level
  if/switch branches, ignores nested ones.
- `sources.test.ts` — manifest keys equal `VIEW_TRANSFORMS` keys.
- `store.test.ts` — addUser rejects non-`user.`-prefixed keys; rejects
  collisions; survives a remove-then-re-add.

Component tests (RTL):

- `TypesTab.test.tsx` — search filters correctly, selection updates
  detail panel, chip click switches tabs.
- `TransformsTab.test.tsx` — same shape.
- `TypeAuthoringSheet.test.tsx` — picking an event populates the
  workbench; "matches sample" indicator flips when the user edits the
  selector text.

No snapshot tests for the source block; the highlighter output is
considered an implementation detail.

## Edge cases / failure modes

- **Selector parse error in authoring sheet.** The engine throws → catch
  and render inline error on the selector field; "matches sample"
  indicator goes to a neutral "—" state until parse succeeds.
- **Sample payload not valid JSON when displayed.** Shouldn't happen
  (built-in samples are real objects), but guard with a try/catch
  around `JSON.stringify`; fall back to `String(payload)`.
- **Transform whose `matches` references an unknown key.** Render the
  chip with a "?" badge and a tooltip "selector not in registry"
  rather than hiding it. Surfaces drift.
- **Empty event stream when picking an event.** Show "(no events in
  the current panel — paste JSON or write a raw selector)".
- **User authors a selector, then the panel they were inspecting
  changes.** Selectors live in the modal's store, not the panel — they
  persist across panel switches within the session. Refresh wipes them.

## Open questions

- **Client-side Event parser.** `server/src/parser.ts` is the canonical
  validator but it lives server-side. Do we (a) duplicate a small shape
  check into the client, (b) call a tRPC endpoint to validate, or (c)
  trust whatever JSON the user pastes and let the inference / selector
  match handle malformed input? Lean toward (c) for v1.
- **Syntax highlighter choice.** `shiki` vs. a homegrown regex tokenizer
  vs. plain `<pre>`. Decide at impl after checking current bundle.
- **"Used by" reverse index timing.** Computed once per render from
  `VIEW_TRANSFORMS` + `selectors.all` (cheap — both lists are <50
  entries). If they grow, memoize on the store.
- **Trace tab placeholder vs. hidden.** Render it disabled-but-visible
  (current plan) or hide it until Spec 3 ships? Visible feels better —
  signals the work in progress and keeps the tab strip stable.

## Out of scope (deferred)

- Persistence of user-authored selectors.
- Selector versioning / namespacing beyond `user.` prefix.
- Showing pipeline output before/after a transform (a "preview" mode).
- Editing transforms inline.
- Exporting selectors as a JSON bundle.
