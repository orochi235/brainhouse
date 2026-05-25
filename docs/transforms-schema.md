# Brainhouse — transformations schema

The contract for how event-processing logic — both shipped-built-in and
user-authored — gets defined, loaded, and executed.

Status: **design** — Stage A (refactor existing logic into the schema)
not yet implemented. This doc is the spec we'll build to.

---

## Two kinds of transforms

Brainhouse separates transforms into two execution contexts based on
what they're doing:

| Kind     | Where it runs | What it touches              | Examples (existing)                |
|----------|---------------|------------------------------|------------------------------------|
| `state`  | server        | Panel-level fields, SQLite   | token accumulation, awaiting_input, ended, theme stamping |
| `view`   | client        | View items (transcript shape) | tool capsules, op-strips, file-change rows, canceled-turn marking |

The kinds map to the two genuinely different things a transform can
do: **mutate the model** (rare, persisted, server-canonical) vs.
**project the model into a display** (frequent, ephemeral,
recomputed from events on each render).

User transforms declare their kind at registration:

```ts
export const myStateTransform: Transform<'state'> = {
  kind: 'state',
  key: 'my-tag',
  /* … */
};

export const myViewTransform: Transform<'view'> = {
  kind: 'view',
  key: 'hide-reads',
  /* … */
};
```

If a single concept needs both effects, it ships as two transforms
that communicate via panel-level attrs (a `state` transform writes
`panel.attrs['foo']`; a `view` transform reads it). `panel.attrs` is
a free-form key/value bag persisted alongside the rest of the panel
state — the bridge between the two processes, not XML-style tags.

---

## The `Transform` type

```ts
interface BaseTransform {
  /** Unique within the active set. Used for ordering, override, and
   * the UI browser. Conventional namespacing: `built-in.<slug>` for
   * shipped transforms, `<package-or-folder>.<slug>` for user ones. */
  key: string;

  /** Human-readable name for the UI browser. */
  name: string;

  /** One-line description; longer rationale goes in a doc comment
   * on the run function. */
  description: string;

  /** Optional hint about source location, set automatically for
   * built-ins via build-time injection. User transforms set it
   * themselves if they want richer UI links. */
  source?: { file: string; line?: number };
}

interface StateTransform extends BaseTransform {
  kind: 'state';
  /** Runs once per ingested event, on the server, during
   * SessionStore.apply(). Mutations to `panel` are persisted via the
   * normal write-through path. */
  run(event: Event, panel: Panel, ctx: StateContext): void | StateMutation[];
}

interface Stage1Transform extends BaseTransform {
  kind: 'view';
  stage: 1;
  /** Runs once per event, in registration order. The first transform to
   * return `true` consumes the event — subsequent stage-1 transforms
   * don't see it. May mutate `items` in place (push new entries, or
   * edit prior ones — e.g. attach a tool_result to a prior capsule). */
  run(event: Event, items: ViewItem[], ctx: ViewContext): boolean | void;
}

interface Stage2Transform extends BaseTransform {
  kind: 'view';
  stage: 2;
  /** Runs once over the assembled item list, in registration order.
   * Returns a new array (must not mutate the input). */
  run(items: ViewItem[], ctx: ViewContext): ViewItem[];
}

type ViewTransform = Stage1Transform | Stage2Transform;

type Transform = StateTransform | ViewTransform;
```

Stage 1 and Stage 2 are different because the work is different.
Stage 1 transforms are "react to an event"; they need to see the
event in context (prior items, scratch state) and the natural shape
is in-place mutation. Stage 2 transforms are pure list reshapers
(coalesce / compress); the natural shape is `items → items'`.

### State context

```ts
interface StateContext {
  /** Read-only access to other panels in the same session group
   * (parent + its subagents). For cross-panel transforms like
   * "mark parent as awaiting if any subagent is."  */
  readPanel(id: string): Readonly<Panel> | undefined;
  /** Set an attr on a panel — defaults to the current panel, but
   * accepts an explicit panelId for cross-panel writes (e.g. a
   * subagent state transform updating its parent). Reaches SQLite
   * via the normal upsert path; cross-panel writes emit a
   * `panel_upsert` delta for the target panel. */
  setAttr(key: string, value: unknown, panelId?: string): void;
}
```

### View context

```ts
interface ViewContext {
  /** The raw event list — some stage-1 transforms need to look back at
   * earlier events (not just rendered items) to make their decision.
   * Read-only. */
  allEvents: readonly Event[];
  /** Mutable state shared across all stage-1 transforms in a single
   * pipeline pass — `pending` flag, `checklist`, `absorbedToolUseIds`.
   * The runner returns the final values as part of PreprocessResult.
   * (Future: panel.attrs are exposed here too once state transforms
   * land in the second commit.) */
  scratch: ViewPipelineScratch;
}
```

Stage-1 transforms return `true` to consume the event (subsequent
stage-1 transforms skip it) or `false`/`void` to pass through.
Mutations happen directly on the `items` array — both pushes and
edits to prior items (e.g. `foldToolAck` setting `last.ack = text`;
`markCanceledTurn` walking back to stamp `canceled: true`).

---

## Composition

Three layers, applied in order:

```
built-in transforms              (shipped with brainhouse, in source)
  ↓
~/.brainhouse/transforms/*.ts    (user-global; cross-project conventions)
  ↓
<cwd>/.brainhouse.ts             (per-project; specific to one cwd)
```

For each panel, the active transform list is the concatenation, with
**later layers overriding earlier ones by `key`**.

- Same `key` later in the chain → previous version is dropped entirely.
- No separate `disable` mechanism — to disable a built-in, register a
  same-keyed transform whose `run` is a no-op. One concept does both
  jobs.

Built-in transforms have the convention `built-in.*` for their
keys; user transforms should not collide with that namespace unless
they're deliberately overriding.

---

## Execution

**State transforms** run inside `SessionStore.apply()` on the server,
once per ingested event. They participate in the same dedupe and
write-through pipeline that touches `panel_upsert` deltas today. The
runner wraps each transform in a try/catch (see *Error contract*
below).

**View transforms** run inside `preprocessEvents()` on the client,
once per render (memoized on `panel.events`). Stage-1 transforms see
each event in order; Stage-2 transforms see the fully assembled item
list. Same try/catch wrap.

Hot reload:
- Editing a built-in transform: Vite HMR for the client side, tsx
  watch for the server side. Same as today.
- Editing a user transform (`.brainhouse.ts`): server's file watcher
  picks up the change, recompiles via esbuild, broadcasts a
  `transforms_updated` delta. Client re-runs `preprocessEvents` for
  all affected panels.

---

## Error contract

Every transform call is wrapped in try/catch. On exception:

1. The transform's mutation is **discarded** — pipeline proceeds as
   though that transform did nothing for that event/item.
2. A `TransformError` record is appended to the panel:
   ```ts
   interface TransformError {
     transformKey: string;
     message: string;
     eventUuid?: string;
     ts: number;
   }
   ```
3. The error surfaces in the UI as a small warning row in the panel
   header (or a toast on first occurrence). The panel keeps working.

User transforms that throw don't break the panel, don't break the
session, and don't get retried automatically. Persistent errors stay
visible until the offending transform is fixed or removed.

---

## Trust model for user transforms

`.brainhouse.ts` files are *executable TypeScript dropped into a
directory you cd'd into*. We follow the direnv model:

1. First time the server sees a new `.brainhouse.ts` (or one with a
   changed hash), it does **not** load it.
2. A trust prompt surfaces in the UI: *"Trust transforms from
   `<absolute-path>`?"* — with the file contents previewable.
3. Trust is granted per-file-hash + per-path, stored in SQLite.
4. Modifying the file invalidates the trust; re-prompt.

`~/.brainhouse/transforms/` is implicitly trusted (it's the user's
own directory). Switching to "trust by directory + content hash" for
user-global too would be an easy follow-up if desired.

---

## Stage A vs Stage B

**Stage A (in progress — two commits):**
- *Commit 1 (landed):* View-side. `ViewTransform` types, registry,
  runner, eleven built-in view transforms under
  `client/src/transforms/builtIn/`. TransformsModal reads from the
  registry. `pipeline.ts` is now a thin re-export shim.
- *Commit 2 (pending):* State-side. `StateTransform` types,
  registry, runner; refactor `SessionStore.apply()` mutations
  (token accumulation, awaiting_input, ended, title/agent/theme
  from meta) into `server/src/transforms/builtIn/`.

**Stage B (follow-up):**
- esbuild on the server; user transform discovery (global + per-cwd)
- Trust prompts + per-cwd `.brainhouse.ts` loading
- Hot reload of user transforms
- Error surfacing in the UI

**Stage C (later, if/when):**
- In-app TypeScript editor (Monaco) for authoring without leaving
  brainhouse
- Live preview against fixture event streams

Stage A is the substrate; B is the customization layer; C is the
sugar. Each can ship independently once A is done.

---

## Open questions

These are real choices but I'd defer them until Stage A is in:

- **Attr schema**. `setAttr(key, value, panelId?)` is permissive —
  values are `unknown`. Do we want attr values to be typed
  (Zod-schema'd) per key, declared by whichever transform owns the
  key? Free-form is easier and matches what the built-ins need
  today; typed catches cross-transform typos and gives the in-app
  editor (Stage C) something to autocomplete against. Defer until a
  concrete pain shows up.
- **Reordering within a layer**. Built-ins are ordered by their
  registration order (source-file order). Should user transforms get
  a `before: ['key']` / `after: ['key']` hint? Without it, the only
  ordering is "later layers run later." Punted for v1.

## Event tags

Every `Event` returned by `parseLine` carries a `tags: Tag[]` array
computed once at parse time. Downstream code should classify events
via tags (`hasTag(event, 'meta')`) rather than re-deriving from `kind`
+ payload shape — Claude Code's JSONL schema shifts upstream from
time to time, and centralizing the classifier in `parser.ts` keeps
each schema change isolated to one file.

Taxonomy (see `Tag` in `server/src/parser.ts` for the source of truth):

| tag | applied to | composes with |
|---|---|---|
| `dialogue` | direct user↔agent text only. `user_text` (sans `artifact` / `meta`) + `assistant_text`. Excludes `thinking`, `tool_use`/`tool_result`. | `sidechain` |
| `tool` | `tool_use`, `tool_result` | `sidechain` |
| `thinking` | the model's extended thinking (kind === `'thinking'`) | `sidechain` |
| `artifact` | Claude Code slash-command scaffolding emitted as user_text: `<local-command-caveat>`, `<command-name>`, `<command-message>`, `<command-args>`, `<local-command-stdout>` | `slash_command`, `sidechain` |
| `slash_command` | a user_text artifact specifically of the form `<command-name>...</command-name>`. Always co-resident with `artifact`. | `artifact`, `sidechain` |
| `meta` | sidechannel records — kind === `'meta'`, OR an `is_meta: true` user_text. Does NOT bump a done/mini panel back to live. | `sidechain` |
| `system` | kind === `'system'` | — |
| `sidechain` | raw record had `isSidechain: true` (subagent transcripts). | composes with everything |
| `usage` | kind === `'resource_usage'` | — |

Tags are additive (an event can carry several) and computed once in
`parseLine` — there is intentionally no second pass that needs
cross-record context. If a future classifier genuinely needs that
(e.g. "this user_text is the first post-`/clear` prompt"), revisit
then rather than build the machinery preemptively.

Synthetic events constructed outside the parser (auto-title meta,
subagent-meta from the watcher) must set their own `tags` explicitly
— there's no auto-tagger for them. `hasTag` is defensive against a
missing `tags` field (returns false) but missing tags should be
treated as a bug to fix at the constructor.
