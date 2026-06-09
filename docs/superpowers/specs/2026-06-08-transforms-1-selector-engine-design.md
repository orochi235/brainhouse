# Transforms inspector — Spec 1 of 3: selector engine + migration

Date: 2026-06-08
Status: draft

## Context

This is the first of three parallel specs that together replace the
ad-hoc `if (event.kind === …)` guards at the top of every view
transform's `run()` with a declared, inspectable **selector**. The
selector machinery is also the substrate for the inspector modal
(Specs 2 and 3) to render "what this transform matches" and
"what fired on this event" without re-deriving it from source.

The three specs:

1. **(this one)** Selector engine + migration of the 18 built-in view
   transforms. No UI.
2. Inspector modal modes A/B — types catalog (every named selector,
   its pattern, sample payload) + transform browser (each transform's
   matches, source link, registry order). Reads only from Spec 1's
   types module.
3. Inspector modal mode C — live trace ("which transforms saw which
   events, who consumed each one") + debug snapshot export. Hooks
   into a runner trace callback added in Spec 1.

Specs 2 and 3 must compile against the seam declared here before
Spec 1's runtime exists; they pull `SelectorDef` and `Selector` from
the same module path on day one.

## Goals

- Introduce a small CSS-like selector primitive that addresses
  `Event` shape (kind, payload attribute equality, regex over text,
  nested content-block structure for `tool_use`).
- Add a registry of **named selectors** (`SelectorDef`) — keyed,
  human-named, described, with the selector source and an optional
  sample payload for catalog UI.
- Extend `BaseTransform` with an optional `matches?: string[]` field.
  Each entry is a `SelectorDef.key`. The runner short-circuits stage-1
  dispatch: if `matches` is present and no listed selector hits the
  current event, the transform's `run` is skipped.
- Migrate the 18 existing built-ins to declare `matches` and drop the
  now-redundant kind/payload guards from their `run` bodies.
- Preserve stage-1 "first to return true consumes" semantics exactly.
- Preserve the existing error contract (per-transform try/catch).

## Non-goals

- No UI work. The selector authoring/browsing UI is Spec 2.
- No runtime trace UI. Spec 3 owns the trace surface; this spec only
  exposes the hook (see *Runner trace seam*).
- No persistence — selectors are code, not stored data.
- No user-loaded transforms. Stage B of `transforms-schema.md`
  remains future work; nothing here blocks it.
- No state-transform changes. State transforms run on the server in
  a different pipeline; `matches` is view-side only for now.
- No selector composition operators beyond what the migration needs
  (`,`, `>`, `:matches`, `:has`, attribute equality, attribute
  presence). No `~`, `+`, `:not`, `:nth-child`. Add later if a
  concrete transform needs them.

## Shared seam

This is the contract Specs 2 and 3 build against. It lands as part of
Spec 1 and must match verbatim.

```ts
// client/src/transforms/selectors/types.ts

import type { Event } from '@server/parser.ts';

export interface SelectorNode {
  // Discriminated AST node — shape detailed in "Grammar" below.
  // Kept exported so the inspector can render the parse tree.
  type:
    | 'kind'
    | 'attr-eq'
    | 'attr-present'
    | 'matches'
    | 'child'
    | 'has'
    | 'group';
  // ...fields per variant
}

export interface Selector {
  source: string;
  ast: SelectorNode;
  match: (e: Event) => boolean;
}

export interface SelectorDef {
  key: string;
  name: string;
  description: string;
  selector: string;
  /** Optional fixture payload used by the catalog UI to demonstrate
   * what an event matching this selector looks like. Not used at
   * runtime. */
  samplePayload?: unknown;
}
```

```ts
// client/src/transforms/types.ts
interface BaseTransform {
  // existing fields …
  /** Selector keys from `SELECTOR_REGISTRY`. If present, the runner
   * skips this transform's `run` for events that match none of them.
   * Omitted = run on every event (current behavior). */
  matches?: string[];
}
```

```ts
// Trace seam consumed by Spec 3. Declared here so Spec 3 doesn't
// fork the runner. One TraceRecord per event; perStage entries are
// emitted in registration order. finalItemIndices is filled in after
// stage 2 completes — Spec 3 owns the attribution logic.
export interface TraceRecord {
  eventUuid: string;
  perStage: Array<{
    transformKey: string;
    selectorKey?: string;     // which named selector matched, if any
    matched: boolean;         // selector matched (or no `matches` declared)
    ran: boolean;             // run() was invoked
    consumed: boolean;        // stage-1 returned true
    mutatedItems: boolean;    // heuristic — Spec 3 details
    error?: TransformError;
  }>;
  finalItemIndices: number[]; // indices into the post-pipeline items[]
}
```

The runner exposes an optional `trace?: TraceRecord[]` in
`RunViewPipelineOpts`. When supplied, the runner appends one record
per event, building `perStage` entries inline as each stage-1
transform is dispatched. `finalItemIndices` is left empty by Spec 1;
Spec 3's post-stage-2 pass fills it in. When `trace` is omitted, the
runner takes a fast path with no allocation. Spec 3 owns the
mutation-detection heuristic and the post-pass attribution; Spec 1's
only obligation is the per-stage record skeleton at the call site.

## Grammar

Strawman BNF. The token vocabulary is deliberately tiny.

```
selector       := group ( ',' group )*
group          := simple ( combinator simple )*
combinator     := '>'           // navigate into nested structure
simple         := type-sel? ( filter )*
type-sel       := IDENT         // 'event' | 'tool_use' | 'content' | …
filter         := '[' attr ']'
               |  ':matches(' regex ')'
               |  ':has(' selector ')'
attr           := IDENT          // presence:  [name]
               |  IDENT '=' value
value          := STRING | IDENT
regex          := '/' BODY '/' FLAGS?
```

### Structural model

The selector evaluates against an `Event`. For matching purposes the
event is treated as a node of type `event` with attributes:

- `kind`     → `event.kind`
- `uuid`     → `event.uuid`
- every key on `event.payload` is exposed as an attribute (string
  values matched by `=`; `:matches` runs against a stringified body).
- `:matches(/…/)` on `event` runs against the canonical text body
  (`event.payload.text` for text events; for `tool_use` the JSON of
  `payload.input`; for `tool_result` the result string).

Child navigation (`>`) descends one level:

- `event > tool_use` — payload `kind === 'tool_use'` (equivalent to
  `event[kind=tool_use]` — provided for readability).
- `event[kind=tool_use] > content[type=text]` — over each block in
  `payload.content` (the JSON-block shape Claude Code emits inside
  tool_use payloads). v1 only formalizes this descent for `tool_use`
  / `tool_result` content arrays; other event kinds have no children.

`:has(s)` is true if any descendant matches `s`. `:has` cannot
introduce new child types — it operates on the same descent rules.

### Examples

These cover every existing transform's guard:

```
event[kind=tool_use][name=TodoWrite]
event[kind=tool_use][name=Task]
event[kind=tool_use][name=AskUserQuestion]
event[kind=tool_use]
event[kind=tool_result]
event[kind=assistant_text]
event[kind=assistant_text]:matches(/<<bh-title>>[^]*<\/bh-title>>$/)
event[kind=user_text]
event[kind=user_text]:matches(/<bash-(input|stdout|stderr)>/)
event[kind=user_text]:has(tag[name=meta])
event[kind=user_text]:has(tag[name=artifact])
event[kind=user_text]:has(tag[name=slash_command])
event[kind=meta]
event[kind=thinking], event[kind=system], event[kind=meta]
event[kind=user_text], event[kind=tool_result]
```

`tag[name=…]` is a special pseudo-child: the parser surfaces
`event.tags` as `tag` children with a single `name` attribute. This
covers every existing `hasTag` call site without inventing new
syntax for them.

## Implementation

### Layout

```
client/src/transforms/selectors/
  types.ts         // Selector, SelectorNode, SelectorDef, TraceRecord
  parse.ts         // string → SelectorNode  (handwritten recursive-descent)
  compile.ts       // SelectorNode → (e: Event) => boolean
  registry.ts      // SELECTOR_REGISTRY: SelectorDef[]  +  resolve(key) cache
  parse.test.ts
  compile.test.ts
  registry.test.ts
```

No external dependency. The grammar is small enough that a ~150-line
handwritten tokenizer + recursive-descent parser is the right call;
pulling in `nearley` / `peggy` is more friction than the parser
itself.

`compile.ts` walks the AST once and returns a closure. The closure
captures pre-built regexes (compiled at registry-load time, not per
event). Closure is pure; selectors are immutable post-registration.

`registry.ts` exports `SELECTOR_REGISTRY: SelectorDef[]` and
`resolveSelector(key: string): Selector` (memoized — first call
compiles, later calls return the cached `Selector`). Unknown key
throws at the runner; transforms with an unknown `matches[]` entry
fail fast on first use rather than silently no-op.

### `BaseTransform.matches`

Added as `matches?: string[]`. Empty array is treated as "match
nothing" (the transform never runs); omitted is "match everything"
(current behavior). Documented on the type.

### Runner changes

`client/src/transforms/runner.ts`:

```ts
for (const event of events) {
  const record: TraceRecord | undefined = opts.trace
    ? { eventUuid: event.uuid, perStage: [], finalItemIndices: [] }
    : undefined;
  for (const t of stage1) {
    const matchHit = t.matches ? firstSelectorHit(t.matches, event) : 'any';
    const matched = matchHit !== null;
    if (!matched) {
      record?.perStage.push({ transformKey: t.key, matched: false, ran: false,
                              consumed: false, mutatedItems: false });
      continue;
    }
    let consumed = false;
    let error: TransformError | undefined;
    // Mutation-detection snapshot is Spec 3's responsibility; omitted here.
    try {
      consumed = t.run(event, items, ctx) === true;
    } catch (err) {
      error = toTransformError(err, t.key, event.uuid);
      console.error(`[transform ${t.key}] threw on event ${event.uuid}:`, err);
    }
    record?.perStage.push({
      transformKey: t.key,
      selectorKey: matchHit === 'any' ? undefined : matchHit,
      matched: true, ran: true, consumed,
      mutatedItems: false, // Spec 3 replaces with real detection
      error,
    });
    if (consumed) break;
  }
  if (record) opts.trace!.push(record);
}
```

`firstSelectorHit` resolves each key via the registry cache and
returns the first matching key (or `null` if none match). When the
transform has no `matches` declared, the runner uses the sentinel
`'any'`.

Stage-2 transforms are not event-routed; `matches` on a stage-2
transform is meaningless. The runner ignores it there; the type
system permits it for shape uniformity but the docstring on
`Stage2Transform` calls this out.

### Error contract

Unchanged. Selector parse/compile errors at registry load are fatal
(thrown at module-eval time — they're code bugs, not runtime data).
Selector match exceptions at runtime are caught and treated as
"no match" with a `console.error`; the per-transform try/catch still
wraps `run()`.

## SelectorDef registry — initial catalog

`client/src/transforms/selectors/registry.ts` ships one entry per
distinct guard observed across the built-ins. Keys are conventional
slugs; transforms reference them by key.

| key                          | selector                                                                       | used by                                              |
|------------------------------|--------------------------------------------------------------------------------|------------------------------------------------------|
| `tool-use.any`               | `event[kind=tool_use]`                                                         | `toolUseToCapsule`                                   |
| `tool-use.todo-write`        | `event[kind=tool_use][name=TodoWrite]`                                         | `todoWriteToChecklist`                               |
| `tool-use.task`              | `event[kind=tool_use][name=Task]`                                              | `taskSubagents`                                      |
| `tool-use.ask-user-question` | `event[kind=tool_use][name=AskUserQuestion]`                                   | `askUserQuestion`                                    |
| `tool-result.any`            | `event[kind=tool_result]`                                                      | `mergeToolResult`, `taskSubagents`                   |
| `assistant-text.any`         | `event[kind=assistant_text]`                                                   | `assistantTextBubble`, `trackPending`                |
| `assistant-text.bh-title`    | `event[kind=assistant_text]:matches(/<<bh-title>>[^]*<\/bh-title>>$/)`         | `stripBhTitleMarker`                                 |
| `user-text.any`              | `event[kind=user_text]`                                                        | `userTextBubble`, `suppressInterruptMarker`          |
| `user-text.bash`             | `event[kind=user_text]:matches(/<bash-(input\|stdout\|stderr)>/)`              | `bashTerminal`                                       |
| `user-text.meta`             | `event[kind=user_text]:has(tag[name=meta])`                                    | `attachSkillPrelude`                                 |
| `user-text.artifact`         | `event[kind=user_text]:has(tag[name=artifact])`                                | `clearMarker`                                        |
| `meta.any`                   | `event[kind=meta]`                                                             | `tagBtwUserText`, `defaultEventItem`                 |
| `thinking.any`               | `event[kind=thinking]`                                                         | `defaultEventItem`                                   |
| `system.any`                 | `event[kind=system]`                                                           | `defaultEventItem`                                   |
| `dialogue.any`               | `event[kind=user_text], event[kind=assistant_text]`                            | `scanChecklist`                                      |
| `pending.bump`               | `event[kind=user_text], event[kind=tool_result], event[kind=assistant_text]`   | `trackPending`                                       |

Each entry includes a one-paragraph `description` and a
`samplePayload` (a representative `Event` literal). `samplePayload`
is consumed only by the Spec 2 catalog UI.

## Migration plan

One commit per transform. Each commit:

1. Adds the appropriate `matches: [...]` field.
2. Removes the now-redundant guard lines from `run()`.
3. Leaves all other logic (payload-shape branching that remains
   non-trivial, e.g. `defaultEventItem`'s three-way switch on kind)
   untouched.

Per-transform table:

| Transform                  | `matches` keys                              | Guard lines removed                                                                                           |
|----------------------------|---------------------------------------------|---------------------------------------------------------------------------------------------------------------|
| `trackPending`             | `['pending.bump']`                          | none — branches on kind to set vs. clear; keep the body, drop the implicit "ignore others" fallthrough.       |
| `scanChecklist`            | `['dialogue.any']`                          | `if (event.kind === 'user_text' || event.kind === 'assistant_text')` guard collapses.                         |
| `taskSubagents`            | `['tool-use.task', 'tool-result.any']`      | two `event.kind === …` branches simplify to direct dispatch on which selector matched.                        |
| `stripBhTitleMarker`       | `['assistant-text.bh-title']`               | `if (event.kind !== 'assistant_text') return false;` + the trailing-tag regex precheck.                       |
| `mergeToolResult`          | `['tool-result.any']`                       | `if (event.kind !== 'tool_result') return false;`                                                             |
| `askUserQuestion`          | `['tool-use.ask-user-question']`            | `if (event.kind !== 'tool_use' || event.payload.name !== 'AskUserQuestion') return false;`                    |
| `todoWriteToChecklist`     | `['tool-use.todo-write']`                   | `if (event.kind !== 'tool_use') return false;` + payload-name check.                                          |
| `toolUseToCapsule`         | `['tool-use.any']`                          | `if (event.kind !== 'tool_use') return false;`                                                                |
| `suppressInterruptMarker`  | `['user-text.any']`                         | `if (event.kind !== 'user_text') return false;`                                                               |
| `clearMarker`              | `['user-text.artifact']`                    | `if (event.kind !== 'user_text') return false;` + `if (!hasTag(event,'artifact')) return false;`              |
| `attachSkillPrelude`       | `['user-text.meta']`                        | `if (event.kind !== 'user_text') return false;` + `if (!hasTag(event,'meta')) return false;`                  |
| `tagBtwUserText`           | `['meta.any', 'user-text.any']`             | top-level `event.kind === 'meta'` / `'user_text'` discrimination keeps its body branches.                     |
| `bashTerminal`             | `['user-text.bash']`                        | `event.kind === 'user_text'` precheck + bash-tag regex precheck.                                              |
| `userTextBubble`           | `['user-text.any']`                         | `if (event.kind !== 'user_text') return false;`                                                               |
| `assistantTextBubble`      | `['assistant-text.any']`                    | `if (event.kind !== 'assistant_text') return false;`                                                          |
| `defaultEventItem`         | `['thinking.any', 'system.any', 'meta.any']`| three top-level `event.kind === …` checks; body keeps its 3-way switch since each branch produces a different wrapper item. |
| `coalesceFileOps`          | — (stage 2)                                 | n/a                                                                                                           |
| `coalesceBetweenChats`     | — (stage 2)                                 | n/a                                                                                                           |
| `insertDayDividers`        | — (stage 2)                                 | n/a                                                                                                           |

Where a transform's `run()` still needs to discriminate between
multiple selectors (`taskSubagents`, `tagBtwUserText`,
`defaultEventItem`), the body branches on `event.kind` exactly as
today — `matches` is a *gate*, not a *dispatcher*. We could add
per-selector callbacks later if a transform ends up needing them;
not on the critical path.

## Backward compatibility

- `matches` is optional. Built-ins not yet migrated keep working.
- The runner change is additive: the "no `matches` declared" path
  is the existing path.
- Existing tests for individual transforms continue to pass during
  migration since the guard logic still produces the same result —
  it just runs earlier (in the selector) instead of inside `run()`.

## Testing

1. **`parse.test.ts`** — round-trip cases covering each grammar
   construct: bare type, attr-eq, attr-present, multiple filters,
   `:matches` with flags, `:has`, child combinator, comma groups,
   nested `:has`. Malformed input cases (unterminated string,
   missing `]`, unknown combinator) assert thrown error with a
   useful message.
2. **`compile.test.ts`** — for each `SELECTOR_REGISTRY` entry, build
   a few representative `Event` fixtures (positive + negative) and
   assert `match()` agrees. Fixtures live in
   `client/src/transforms/selectors/__fixtures__/events.ts`.
3. **`registry.test.ts`** — every registered selector parses,
   compiles, and matches its own `samplePayload`. Detects catalog
   bit-rot.
4. **Migrated transforms** — existing per-transform tests run
   unchanged. We add one regression test in `runner.test.ts` that
   loads a canned fixture session (existing `pipeline.test.ts`
   golden) and asserts the produced `ViewItem[]` is byte-equal
   before and after migration. This is the contract that keeps the
   refactor honest.

## Performance

Per event, the runner now does up to N selector matches (N =
stage-1 transforms with `matches`). Each match is a closure call.
For the existing 18 transforms over a typical 10k-event session,
this is ~150k closure calls — well under a millisecond budget.
Selectors with regex bodies pre-compile their `RegExp` at registry
load, so the per-call cost is one `.test()`.

If profiling later shows hotspots, an obvious optimization is a
"first-pass dispatch table" keyed on `event.kind`: bucket transforms
by which kinds any of their selectors reference, skip a bucket
entirely when the kind doesn't match. Not needed for v1.

## Open questions

1. **`tag[name=…]` syntax**. We're treating `event.tags` as
   pseudo-children with a `name` attribute. Reasonable, but
   `event[tag=meta]` (attribute-style: tag presence as a set
   membership predicate) would read better at call sites. Decide
   before locking the grammar; both shapes parse cleanly. Leaning
   toward `event[tag=meta]` — shorter, no special "pseudo-child"
   concept.
2. **Should `matches` be required for new stage-1 transforms?**
   Lint-level enforcement (an ESLint rule scanning for guard
   patterns) or just a convention? I'd say convention until we have
   a third party authoring transforms.
3. **Where do selectors live for state transforms?** Same module,
   different event surface? Punted out of this spec — state
   transforms run on the server and the parser-side `Event` shape
   is identical, so the selector engine could be reused. Decide
   when state transforms get their own inspector pass.
4. **`samplePayload` location**. Inline in `SelectorDef` keeps the
   catalog self-contained. Alternative: a separate fixtures file
   the catalog reads. Inline is simpler; revisit if payloads grow
   unwieldy.
