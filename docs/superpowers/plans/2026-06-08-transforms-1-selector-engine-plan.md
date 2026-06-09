# Transforms-1 Selector Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace ad-hoc `if (event.kind === …)` guards in 18 built-in view transforms with declared selectors, backed by a small CSS-like selector engine.

**Architecture:** Handwritten recursive-descent parser + tree-walking compiler producing a closure per selector. Named selectors registered in a registry, resolved (memoized) at runner dispatch. Runner gains a stage-1 short-circuit and an optional `trace` accumulator seam (Spec 3 fills semantics later). Migration is per-transform: add `matches: [...]`, drop redundant guards.

**Tech Stack:** TypeScript, Vitest. No new deps.

---

## Spec decisions (open questions)

1. **`tag[name=…]` syntax** — the spec leans toward `event[tag=meta]` (attribute-style). **Decision: use `event[tag=meta]`.** Rationale: shorter, no special pseudo-child concept, parses with the existing `attr-eq` machinery. `event.tags: Tag[]` is exposed under the attribute name `tag`, with equality matching any element in the array.
2. **`assistant-text.bh-title` regex** — the spec table has a placeholder regex (`<<bh-title>>…</bh-title>>`) but the actual marker in code is `<!-- bh-title: ... -->`. **Decision: use the real marker** — selector becomes `event[kind=assistant_text]:matches(/bh-title:/)`. The transform's own `BH_TITLE_MARKER_RE` is still applied inside `run()` for the actual strip.
3. **`event.tags` may be missing** on synthetic test fixtures (the existing pipeline test fixtures omit it). The `attr-eq` evaluator must tolerate `undefined` (treat as empty / no-match), mirroring `hasTag`'s defense.
4. **`todoWriteToChecklist` handles three tool names** (TodoWrite + TaskCreate + TaskUpdate). Spec table only lists `tool-use.todo-write`. **Decision:** add two more registry entries (`tool-use.task-create`, `tool-use.task-update`) so the gate stays accurate.

---

## File structure

Create:
- `client/src/transforms/selectors/parse.ts` — tokenizer + recursive-descent parser
- `client/src/transforms/selectors/compile.ts` — AST → `(e: Event) => boolean`
- `client/src/transforms/selectors/registry.ts` — `SELECTOR_REGISTRY` + memoized `resolveSelector`
- `client/src/transforms/selectors/parse.test.ts`
- `client/src/transforms/selectors/compile.test.ts`
- `client/src/transforms/selectors/registry.test.ts`
- `client/src/transforms/selectors/__fixtures__/events.ts`

Modify:
- `client/src/transforms/runner.ts` — selector short-circuit + optional `trace` accumulator
- `client/src/transforms/builtIn/*.ts` — add `matches`, drop redundant guards (16 stage-1 transforms; stage-2 untouched)

---

## Grammar (concrete subset)

```
selector   := group ( ',' group )*
group      := simple ( '>' simple )*
simple     := IDENT? filter*
filter     := '[' IDENT ('=' (STRING|IDENT))? ']'
           |  ':matches(' regex ')'
           |  ':has(' selector ')'
regex      := '/' body '/' flags?
```

Internal AST node shapes (the public `SelectorNode` from `types.ts` is the structural superset `{ type, [k]: unknown }`):

```ts
type SelNode =
  | { type: 'group'; groups: SelNode[] }
  | { type: 'child'; parent: SelNode; child: SelNode }
  | { type: 'kind'; ident: string }
  | { type: 'attr-eq'; name: string; value: string }
  | { type: 'attr-present'; name: string }
  | { type: 'matches'; re: RegExp }
  | { type: 'has'; inner: SelNode }
  | { type: 'and'; nodes: SelNode[] };
```

---

## Evaluation model

A node evaluates against an event-shaped node. For the `event` context the attribute reads are:

- `kind` → `event.kind`
- `uuid` → `event.uuid`
- `tag`  → matches if `event.tags?.includes(value)` (Array.isArray defensive)
- any other name → `event.payload?.[name]` stringified for `=` comparison

`:matches(/r/)` runs against the canonical text body:
- `assistant_text`/`user_text`/`thinking` → `payload.text`
- `tool_use` → `JSON.stringify(payload.input)`
- `tool_result` → `String(payload.content)`
- else → `''`

`:has(s)` is true if any descendant satisfies `s`. v1 registry doesn't actually need `:has` (we use `[tag=…]`), but we implement it per the grammar for forward compatibility.

`>` descends one level. v1 registry doesn't use this, but we implement it.

---

## Tasks

### Task 1: parser + AST tests (TDD)

**Files:**
- Create: `client/src/transforms/selectors/parse.ts`
- Create: `client/src/transforms/selectors/parse.test.ts`

Tokens: IDENT, STRING (`'…'` or `"…"`), `[`, `]`, `=`, `,`, `>`, `:`, `(`, `)`, REGEX (`/…/flags`), whitespace.

Cover in tests:
- bare type, attr-eq (ident value, quoted string value), attr-present, multiple filters, `:matches` with flags, `:has`, comma groups, `>` combinator
- malformed: unterminated string, unterminated regex, missing `]`

Commit: `transforms/selectors: add selector parser`.

### Task 2: compiler + fixtures + tests

**Files:**
- Create: `client/src/transforms/selectors/__fixtures__/events.ts`
- Create: `client/src/transforms/selectors/compile.ts`
- Create: `client/src/transforms/selectors/compile.test.ts`

`compile(node: SelNode): (e: Event) => boolean`. Pure tree-walk; pre-compiled `RegExp` lives in node.

Fixtures: representative `Event` constants — `userText`, `userTextNoTags`, `userMeta`, `userArtifact`, `userBash`, `asstPlain`, `asstWithBhTitle`, `toolUseBash`, `toolUseTask`, `toolUseTodoWrite`, `toolUseAskUserQuestion`, `toolResult`, `metaEvent`, `thinkingEvent`, `systemEvent`.

Tests: one positive + one negative per selector source actually used in the registry; also one each for `:has`, `>`, group OR, `tag` attribute with missing tags, regex-with-flags.

Commit: `transforms/selectors: add compiler + event fixtures`.

### Task 3: registry + tests

**Files:**
- Create: `client/src/transforms/selectors/registry.ts`
- Create: `client/src/transforms/selectors/registry.test.ts`

Selector keys (extending spec table with the two TaskCreate/TaskUpdate keys):

| key | selector |
|---|---|
| `tool-use.any` | `event[kind=tool_use]` |
| `tool-use.todo-write` | `event[kind=tool_use][name=TodoWrite]` |
| `tool-use.task-create` | `event[kind=tool_use][name=TaskCreate]` |
| `tool-use.task-update` | `event[kind=tool_use][name=TaskUpdate]` |
| `tool-use.task` | `event[kind=tool_use][name=Task]` |
| `tool-use.ask-user-question` | `event[kind=tool_use][name=AskUserQuestion]` |
| `tool-result.any` | `event[kind=tool_result]` |
| `assistant-text.any` | `event[kind=assistant_text]` |
| `assistant-text.bh-title` | `event[kind=assistant_text]:matches(/bh-title:/)` |
| `user-text.any` | `event[kind=user_text]` |
| `user-text.bash` | `event[kind=user_text]:matches(/<bash-(input\|stdout\|stderr)>/)` |
| `user-text.meta` | `event[kind=user_text][tag=meta]` |
| `user-text.artifact` | `event[kind=user_text][tag=artifact]` |
| `meta.any` | `event[kind=meta]` |
| `thinking.any` | `event[kind=thinking]` |
| `system.any` | `event[kind=system]` |
| `dialogue.any` | `event[kind=user_text], event[kind=assistant_text]` |
| `pending.bump` | `event[kind=user_text], event[kind=tool_result], event[kind=assistant_text]` |

`resolveSelector(key)` lazily parses+compiles, caches. Throw with a useful message on unknown key.

Registry test: every entry parses, compiles, and matches its own `samplePayload`.

Commit: `transforms/selectors: add named selector registry`.

### Task 4: runner short-circuit + trace seam

**Files:**
- Modify: `client/src/transforms/runner.ts`

- Add `trace?: TraceRecord[]` to `RunViewPipelineOpts`.
- Inside stage-1 loop: compute `matchHit = t.matches ? firstSelectorHit(t.matches, event) : 'any'`. Skip `run` when not matched. Build per-event `TraceRecord` only when `trace` is supplied.
- Stage-2 unchanged.

Add `runner.test.ts` covering:
- transform with `matches: ['tool-use.any']` skipped for user_text but runs for tool_use
- consume semantics preserved
- `trace` accumulator populated correctly in registration order

Commit: `transforms/runner: stage-1 selector short-circuit + trace seam`.

### Task 5: per-transform migration (16 commits)

After each, run `npm run -w client test -- --run` and confirm `pipeline.test.ts` passes. Migrations listed in order matching the registry (any order works; doing them by registry order keeps reviews tidy).

For each transform: add `matches`, drop the gate checks; keep all body logic intact. Allowed when the body branches on kind to dispatch (e.g. `taskSubagents`, `tagBtwUserText`, `defaultEventItem`, `trackPending`).

### Task 6: typecheck + test + build verification

Run:
- `npm run -w client typecheck` (or repo `npm test`/equivalent)
- `npm run -w client test -- --run`
- `npm run -w client build`

All must pass.

---

## Self-review

- Every registry selector is exercised by at least one transform (Task 5).
- Grammar covers what the v1 catalog uses; `:has` and `>` parse but aren't required by v1.
- `samplePayload` per entry is the catalog rot-detector via `registry.test.ts`.
- Runner change is additive — no-`matches` path is the current path.
- `pipeline.test.ts` is the golden byte-equivalence contract.
