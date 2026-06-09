# Transforms Inspector (Spec 2 of 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the static `TransformsModal` with a tabbed inspector (Types / Transforms / Trace placeholder) backed by a mocked selector engine, ready for the real engine to cut in via a one-line barrel swap.

**Architecture:** New `client/src/components/transforms-inspector/` directory holds tab-level controllers + lists/detail/source-view/authoring sheet. Selector data flows through a React context (`SelectorStoreProvider`) that reads from `client/src/transforms/selectors/index.ts` (mock today, real engine later). Transform source comes from a Vite `?raw` manifest. URL-hash state on the modal carries `inspector/<tab>/<key>` for deep links.

**Tech Stack:** React 19, TypeScript, Vite (`?raw` imports), highlight.js (already a dep) for TS source highlighting, Vitest + Testing Library, Ladle for stories.

---

## File structure

Files created (under `client/src/`):

- `transforms/selectors/types.ts` — frozen shared seam types (`Selector`, `SelectorDef`, `SelectorNode`).
- `transforms/selectors/mock.ts` — `MOCK_SELECTORS`, `mockMatcher`, `resolveSelector` stub.
- `transforms/selectors/index.ts` — barrel re-exporting from `./mock.ts` under the names the real engine will eventually export.
- `transforms/selectors/store.tsx` — `SelectorStoreProvider`, `useSelectors` hook.
- `transforms/selectors/store.test.ts`
- `transforms/types.ts` — extend `BaseTransform` with `matches?: string[]` (read-only consumer in Spec 2).
- `components/transforms-inspector/TransformsInspector.tsx`
- `components/transforms-inspector/TypesTab.tsx`
- `components/transforms-inspector/TypesList.tsx`
- `components/transforms-inspector/TypesDetail.tsx`
- `components/transforms-inspector/TypeAuthoringSheet.tsx`
- `components/transforms-inspector/inference.ts` + `.test.ts`
- `components/transforms-inspector/TransformsTab.tsx`
- `components/transforms-inspector/TransformsList.tsx`
- `components/transforms-inspector/TransformsDetail.tsx`
- `components/transforms-inspector/SourceView.tsx`
- `components/transforms-inspector/sources.ts` + `.test.ts`
- `components/transforms-inspector/outline.ts` + `.test.ts`
- `components/transforms-inspector/chips.tsx`
- `components/transforms-inspector/useHashRoute.ts` — hook for `#inspector/<tab>/<key>` parse+update.
- `components/transforms-inspector/TransformsInspector.stories.tsx`
- `components/transforms-inspector/TypesDetail.stories.tsx`
- `components/transforms-inspector/TypeAuthoringSheet.stories.tsx`
- `components/transforms-inspector/TransformsDetail.stories.tsx`
- `components/transforms-inspector/SourceView.stories.tsx`
- `components/transforms-inspector/TypesTab.test.tsx`
- `components/transforms-inspector/TransformsTab.test.tsx`
- `components/transforms-inspector/TypeAuthoringSheet.test.tsx`

Files modified:

- `components/TransformsModal.tsx` — body replaced with `<TransformsInspector />`; outer modal shell kept.
- `components/TransformsModal.test.tsx` — rewritten against the new inspector shell.
- `components/TransformsModal.stories.tsx` — kept (re-renders modal).
- `App.tsx` — wrap `AppMain` in `<SelectorStoreProvider>`.
- `app.css` — append a `.transforms-inspector` block (no inline styles, no `!important`).

---

### Task 1: Frozen shared seam types

**Files:**
- Create: `client/src/transforms/selectors/types.ts`

- [ ] **Step 1: Create the seam file**

```ts
// client/src/transforms/selectors/types.ts
/**
 * Frozen shared seam between Spec 1 (selector engine), Spec 2 (inspector),
 * and Spec 3 (trace). DO NOT modify the shape of `SelectorDef`, `Selector`,
 * or `SelectorNode` exports without coordinating across all three specs.
 *
 * Spec 2 (this consumer) only reads these types — the parser/engine that
 * builds `Selector.ast` lives in Spec 1.
 */

import type { Event } from '@server/parser.ts';

/** Opaque AST node — Spec 1 owns the grammar. Spec 2 never inspects this. */
export type SelectorNode = unknown;

export interface Selector {
  source: string;
  ast: SelectorNode;
  match: (e: Event) => boolean;
}

export interface SelectorDef {
  /** Stable id, e.g. `"tool-use.todowrite"`. User-authored keys must start with `"user."`. */
  key: string;
  /** Display name, e.g. `"TodoWrite tool_use"`. */
  name: string;
  description: string;
  /** Source string the engine parses. */
  selector: string;
  samplePayload?: unknown;
}
```

- [ ] **Step 2: Commit**

```bash
git add client/src/transforms/selectors/types.ts
git commit -m "$(cat <<'EOF'
client: add frozen selector seam types

Spec 2 of 3 reads these; Spec 1 will add the engine that produces
`Selector` from `SelectorDef.selector`.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Mock selector data + barrel

**Files:**
- Create: `client/src/transforms/selectors/mock.ts`
- Create: `client/src/transforms/selectors/index.ts`

- [ ] **Step 1: Author the mock catalog**

```ts
// client/src/transforms/selectors/mock.ts
/**
 * Stand-in selector data for Spec 2. The real engine lands in Spec 1; cutover
 * is a one-line change in `./index.ts`. Entries below are picked to exercise
 * inspector UI corners — long descriptions, missing sample payload, multi-
 * transform "used by" cross-links, single-transform, none-declared.
 */

import type { Event } from '@server/parser.ts';
import type { Selector, SelectorDef } from './types.ts';

export const MOCK_SELECTORS: SelectorDef[] = [
  {
    key: 'tool-use.todowrite',
    name: 'TodoWrite tool_use',
    description: 'A tool_use event whose tool name is exactly "TodoWrite".',
    selector: 'event[kind=tool_use] > tool_use[name=TodoWrite]',
    samplePayload: {
      kind: 'tool_use',
      payload: {
        tool_use_id: 'toolu_01ABC',
        name: 'TodoWrite',
        input: { todos: [{ content: 'demo', status: 'pending' }] },
      },
    },
  },
  {
    key: 'tool-use.bash',
    name: 'Bash tool_use',
    description: 'A tool_use event whose tool name is "Bash".',
    selector: 'event[kind=tool_use] > tool_use[name=Bash]',
    samplePayload: {
      kind: 'tool_use',
      payload: { tool_use_id: 'toolu_02DEF', name: 'Bash', input: { command: 'ls' } },
    },
  },
  {
    key: 'tool-use.askuserquestion',
    name: 'AskUserQuestion tool_use',
    description: 'A tool_use event for the AskUserQuestion built-in tool.',
    selector: 'event[kind=tool_use] > tool_use[name=AskUserQuestion]',
    samplePayload: {
      kind: 'tool_use',
      payload: { tool_use_id: 'toolu_03GHI', name: 'AskUserQuestion', input: { question: 'go?' } },
    },
  },
  {
    key: 'user-text.bash',
    name: 'Bash-tagged user_text',
    description: 'A user_text event whose body contains a <bash-input> tag — i.e. the user invoked a slash-prefixed bash command.',
    selector: 'event[kind=user_text] > text[contains=<bash-input]',
    samplePayload: {
      kind: 'user_text',
      payload: { text: '<bash-input>ls -la</bash-input>' },
    },
  },
  {
    key: 'assistant-text.bh-title',
    name: 'Assistant <bh-title> marker',
    description: 'An assistant_text event with a trailing <bh-title>…</bh-title> marker that the title transform strips.',
    // NOTE: deliberately no samplePayload to exercise the "(no sample)" UI.
    selector: 'event[kind=assistant_text] > text[contains=<bh-title]',
  },
  {
    key: 'meta.queue-operation',
    name: 'Queue-operation meta',
    description: 'Sidechannel meta event recording a queued /btw operation.',
    selector: 'event[kind=meta] > meta[kind=queue-operation]',
    samplePayload: {
      kind: 'meta',
      payload: { block_type: 'queue-operation', raw: { op: 'add', text: '/btw …' } },
    },
  },
];

/** Stub matcher — always returns false until Spec 1's engine lands. */
export const mockMatcher = (_e: Event) => false;

/**
 * Stub `resolveSelector(key)` — returns a `Selector` whose `match` is the
 * never-matching stub. Spec 1 replaces this barrel; the inspector code path
 * stays unchanged.
 */
export function resolveSelector(_key: string): Selector {
  return { source: '', ast: {} as unknown, match: mockMatcher };
}

/** Compile a raw selector source — stub: never matches, never throws. */
export function compileSelector(source: string): Selector {
  return { source, ast: {} as unknown, match: mockMatcher };
}
```

- [ ] **Step 2: Author the barrel**

```ts
// client/src/transforms/selectors/index.ts
/**
 * Selector engine entry-point. Today this re-exports the mock from
 * `./mock.ts`. When Spec 1 (selector engine + migration) lands, swap the
 * three re-exports below to point at the real implementation. The inspector
 * and any downstream consumer see identical types either way.
 */

export type { Selector, SelectorDef, SelectorNode } from './types.ts';
export { MOCK_SELECTORS as SELECTORS, resolveSelector, compileSelector } from './mock.ts';
```

- [ ] **Step 3: Commit**

```bash
git add client/src/transforms/selectors/mock.ts client/src/transforms/selectors/index.ts
git commit -m "$(cat <<'EOF'
client: stub selector registry behind a one-line barrel

Six MOCK_SELECTORS exercise the inspector UI (short list, long
description, missing-sample, multi-transform "used by"). Cutover to the
real engine is a one-line edit to selectors/index.ts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Extend `BaseTransform` with `matches?: string[]`

**Files:**
- Modify: `client/src/transforms/types.ts:59-66`

- [ ] **Step 1: Add the optional field**

Update `BaseTransform`:

```ts
interface BaseTransform {
  key: string;
  name: string;
  description: string;
  /** Restrict this transform to the listed views. Omitted = runs in all
   * views. */
  views?: ViewName[];
  /** SelectorDef keys this transform "claims" (declarative match rules).
   * Spec 1 populates these on built-in transforms; Spec 2 only reads them
   * to render chips. Undefined = no declared match (legacy/global). */
  matches?: string[];
}
```

- [ ] **Step 2: Commit**

```bash
git add client/src/transforms/types.ts
git commit -m "$(cat <<'EOF'
client: add optional `matches: string[]` to BaseTransform

Read-only consumer in Spec 2 (inspector). Spec 1 will populate the field
on built-in transforms; until then chips render the "(no declared
match)" state.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Selector store (provider + hook + tests)

**Files:**
- Create: `client/src/transforms/selectors/store.tsx`
- Create: `client/src/transforms/selectors/store.test.ts`

- [ ] **Step 1: Write failing tests first**

```ts
// client/src/transforms/selectors/store.test.ts
import { act, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SelectorStoreProvider, useSelectors } from './store.tsx';

function harness(cb: (store: ReturnType<typeof useSelectors>) => void) {
  function Probe() {
    const store = useSelectors();
    cb(store);
    return null;
  }
  return render(
    <SelectorStoreProvider>
      <Probe />
    </SelectorStoreProvider>,
  );
}

describe('SelectorStore', () => {
  it('exposes built-ins from MOCK_SELECTORS with origin=builtin', () => {
    let snap: ReturnType<typeof useSelectors> | null = null;
    harness((s) => { snap = s; });
    expect(snap!.all.length).toBeGreaterThan(0);
    for (const s of snap!.all) expect(s.origin).toBe('builtin');
  });

  it('rejects user keys without the `user.` prefix', () => {
    let s: ReturnType<typeof useSelectors> | null = null;
    harness((store) => { s = store; });
    expect(() =>
      s!.addUser({ key: 'nope', name: 'x', description: '', selector: '' }),
    ).toThrow(/user\./);
  });

  it('rejects collisions with built-in keys', () => {
    let s: ReturnType<typeof useSelectors> | null = null;
    harness((store) => { s = store; });
    expect(() =>
      s!.addUser({
        key: 'tool-use.todowrite',
        name: 'x',
        description: '',
        selector: '',
      }),
    ).toThrow(/user\./);
  });

  it('survives remove-then-re-add', () => {
    let calls = 0;
    let last: ReturnType<typeof useSelectors> | null = null;
    function Probe() {
      const s = useSelectors();
      last = s;
      calls++;
      return null;
    }
    const { rerender } = render(
      <SelectorStoreProvider>
        <Probe />
      </SelectorStoreProvider>,
    );
    act(() => {
      last!.addUser({ key: 'user.foo', name: 'foo', description: '', selector: '' });
    });
    rerender(
      <SelectorStoreProvider>
        <Probe />
      </SelectorStoreProvider>,
    );
    act(() => { last!.removeUser('user.foo'); });
    act(() => {
      last!.addUser({ key: 'user.foo', name: 'foo', description: '', selector: '' });
    });
    expect(last!.byKey.get('user.foo')?.origin).toBe('user');
    expect(calls).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

```
cd client && npx vitest run src/transforms/selectors/store.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 3: Implement the store**

```tsx
// client/src/transforms/selectors/store.tsx
/**
 * Union of built-in + user-authored selectors, exposed via React context.
 * User entries are namespaced (`user.` prefix) — collisions with built-ins
 * are rejected. v1 is in-memory only; refresh wipes user entries.
 */

import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';
import { SELECTORS, type SelectorDef } from './index.ts';

export type SelectorOrigin = 'builtin' | 'user';
export type StoredSelectorDef = SelectorDef & { origin: SelectorOrigin };

export interface SelectorStore {
  all: StoredSelectorDef[];
  byKey: Map<string, StoredSelectorDef>;
  addUser(def: SelectorDef): void;
  removeUser(key: string): void;
}

const Ctx = createContext<SelectorStore | null>(null);

const BUILTINS: StoredSelectorDef[] = SELECTORS.map((s) => ({ ...s, origin: 'builtin' }));
const BUILTIN_KEYS = new Set(BUILTINS.map((s) => s.key));

export function SelectorStoreProvider({ children }: { children: ReactNode }) {
  const [userEntries, setUserEntries] = useState<StoredSelectorDef[]>([]);

  const addUser = useCallback((def: SelectorDef) => {
    if (!def.key.startsWith('user.')) {
      throw new Error(`user-authored selector keys must start with "user." (got "${def.key}")`);
    }
    if (BUILTIN_KEYS.has(def.key)) {
      throw new Error(`key "${def.key}" collides with a built-in selector`);
    }
    setUserEntries((prev) => {
      if (prev.some((p) => p.key === def.key)) {
        throw new Error(`user selector "${def.key}" already exists`);
      }
      return [...prev, { ...def, origin: 'user' }];
    });
  }, []);

  const removeUser = useCallback((key: string) => {
    setUserEntries((prev) => prev.filter((p) => p.key !== key));
  }, []);

  const store = useMemo<SelectorStore>(() => {
    const all = [...BUILTINS, ...userEntries];
    const byKey = new Map(all.map((s) => [s.key, s]));
    return { all, byKey, addUser, removeUser };
  }, [userEntries, addUser, removeUser]);

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

export function useSelectors(): SelectorStore {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSelectors must be inside <SelectorStoreProvider>');
  return ctx;
}
```

- [ ] **Step 4: Re-run tests; all pass**

```
cd client && npx vitest run src/transforms/selectors/store.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add client/src/transforms/selectors/store.tsx client/src/transforms/selectors/store.test.ts
git commit -m "$(cat <<'EOF'
client: in-memory selector store with user-namespace guard

`user.` prefix is required for user entries; collisions with built-ins
throw. Exposes union list + byKey map via React context.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Wire `<SelectorStoreProvider>` into `App.tsx`

**Files:**
- Modify: `client/src/App.tsx` (`AppMain` wrapper)

- [ ] **Step 1: Import + wrap**

In `App.tsx`, add the import near the other `./components` lines:

```tsx
import { SelectorStoreProvider } from './transforms/selectors/store.tsx';
```

Wrap the return of `AppMain` (the entire `<LightboxProvider>...</LightboxProvider>` tree) in `<SelectorStoreProvider>...</SelectorStoreProvider>`.

- [ ] **Step 2: Typecheck**

```
cd client && npx tsc -b --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add client/src/App.tsx
git commit -m "$(cat <<'EOF'
client: install SelectorStoreProvider at the app root

Inspector + any future consumer share one in-memory store of built-in +
user-authored selectors.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `?raw` source manifest + drift-guard test

**Files:**
- Create: `client/src/components/transforms-inspector/sources.ts`
- Create: `client/src/components/transforms-inspector/sources.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// client/src/components/transforms-inspector/sources.test.ts
import { describe, expect, it } from 'vitest';
import { VIEW_TRANSFORMS } from '../../transforms/registry.ts';
import { TRANSFORM_SOURCE } from './sources.ts';

describe('TRANSFORM_SOURCE manifest', () => {
  it('has one entry per registered transform, same keys', () => {
    const manifest = Object.keys(TRANSFORM_SOURCE).sort();
    const registry = VIEW_TRANSFORMS.map((t) => t.key).sort();
    expect(manifest).toEqual(registry);
  });

  it('every entry is a non-empty string', () => {
    for (const [key, src] of Object.entries(TRANSFORM_SOURCE)) {
      expect(typeof src, key).toBe('string');
      expect(src.length, key).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run; expect FAIL (module not found).**

```
cd client && npx vitest run src/components/transforms-inspector/sources.test.ts
```

- [ ] **Step 3: Write the manifest**

```ts
// client/src/components/transforms-inspector/sources.ts
/**
 * Static manifest mapping every transform key to its TypeScript source,
 * loaded at build time via Vite's `?raw` import suffix. The drift-guard
 * test in `./sources.test.ts` enforces 1:1 with `VIEW_TRANSFORMS`.
 *
 * Adding a new transform: one import line here, one entry in the object.
 */

import askUserQuestionSrc from '../../transforms/builtIn/askUserQuestion.ts?raw';
import assistantTextBubbleSrc from '../../transforms/builtIn/assistantTextBubble.ts?raw';
import attachSkillPreludeSrc from '../../transforms/builtIn/attachSkillPrelude.ts?raw';
import clearMarkerSrc from '../../transforms/builtIn/clearMarker.ts?raw';
import coalesceBetweenChatsSrc from '../../transforms/builtIn/coalesceBetweenChats.ts?raw';
import coalesceFileOpsSrc from '../../transforms/builtIn/coalesceFileOps.ts?raw';
import defaultEventItemSrc from '../../transforms/builtIn/defaultEventItem.ts?raw';
import insertDayDividersSrc from '../../transforms/builtIn/insertDayDividers.ts?raw';
import mergeToolResultSrc from '../../transforms/builtIn/mergeToolResult.ts?raw';
import scanChecklistSrc from '../../transforms/builtIn/scanChecklist.ts?raw';
import stripBhTitleMarkerSrc from '../../transforms/builtIn/stripBhTitleMarker.ts?raw';
import suppressInterruptMarkerSrc from '../../transforms/builtIn/suppressInterruptMarker.ts?raw';
import tagBtwUserTextSrc from '../../transforms/builtIn/tagBtwUserText.ts?raw';
import taskSubagentsSrc from '../../transforms/builtIn/taskSubagents.ts?raw';
import todoWriteToChecklistSrc from '../../transforms/builtIn/todoWriteToChecklist.ts?raw';
import toolUseToCapsuleSrc from '../../transforms/builtIn/toolUseToCapsule.ts?raw';
import trackPendingSrc from '../../transforms/builtIn/trackPending.ts?raw';
import userTextBubbleSrc from '../../transforms/builtIn/userTextBubble.ts?raw';

export const TRANSFORM_SOURCE: Record<string, string> = {
  trackPending: trackPendingSrc,
  scanChecklist: scanChecklistSrc,
  taskSubagents: taskSubagentsSrc,
  stripBhTitleMarker: stripBhTitleMarkerSrc,
  mergeToolResult: mergeToolResultSrc,
  askUserQuestion: askUserQuestionSrc,
  todoWriteToChecklist: todoWriteToChecklistSrc,
  toolUseToCapsule: toolUseToCapsuleSrc,
  suppressInterruptMarker: suppressInterruptMarkerSrc,
  clearMarker: clearMarkerSrc,
  attachSkillPrelude: attachSkillPreludeSrc,
  tagBtwUserText: tagBtwUserTextSrc,
  userTextBubble: userTextBubbleSrc,
  assistantTextBubble: assistantTextBubbleSrc,
  defaultEventItem: defaultEventItemSrc,
  coalesceFileOps: coalesceFileOpsSrc,
  coalesceBetweenChats: coalesceBetweenChatsSrc,
  insertDayDividers: insertDayDividersSrc,
};
```

**NOTE on transform-`key` lookup:** the keys above match each transform's
`.key` field. If the drift test fails, open the transform file and read its
exported `key` — that's the source of truth.

- [ ] **Step 4: Verify each transform's `.key` matches the manifest entry**

Run a one-shot check that every `VIEW_TRANSFORMS[i].key` is in the
manifest. (The test does this; just run it.)

```
cd client && npx vitest run src/components/transforms-inspector/sources.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/transforms-inspector/sources.ts client/src/components/transforms-inspector/sources.test.ts
git commit -m "$(cat <<'EOF'
client(inspector): ?raw transform-source manifest + drift guard

Manifest keys are asserted equal to VIEW_TRANSFORMS keys so adding a
transform without updating the manifest fails CI.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Outline (regex outliner) + tests

**Files:**
- Create: `client/src/components/transforms-inspector/outline.ts`
- Create: `client/src/components/transforms-inspector/outline.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// client/src/components/transforms-inspector/outline.test.ts
import { describe, expect, it } from 'vitest';
import { outline } from './outline.ts';

describe('outline()', () => {
  it('captures exported function declarations', () => {
    const src = `export function run(event, items, ctx) {\n  return false;\n}\n`;
    expect(outline(src)).toEqual([
      { line: 1, label: 'function run(event, items, ctx)', kind: 'decl' },
    ]);
  });

  it('captures top-level const lambdas', () => {
    const src = `const foo = () => 1;\nexport const bar = (x: number) => x;\n`;
    expect(outline(src)).toEqual([
      { line: 1, label: 'const foo', kind: 'decl' },
      { line: 2, label: 'const bar', kind: 'decl' },
    ]);
  });

  it('captures top-level if / switch / case branches inside a run body', () => {
    const src = [
      'export function run(e) {',
      '  if (e.kind === "tool_use") {',
      '    doA();',
      '  } else if (e.kind === "tool_result") {',
      '    doB();',
      '  } else {',
      '    doC();',
      '  }',
      '  switch (e.kind) {',
      '    case "x":',
      '      return 1;',
      '    case "y":',
      '      return 2;',
      '  }',
      '}',
    ].join('\n');
    const got = outline(src);
    const labels = got.map((o) => o.label);
    expect(labels).toContain('function run(e)');
    expect(labels).toContain('if (e.kind === "tool_use")');
    expect(labels).toContain('else if (e.kind === "tool_result")');
    expect(labels).toContain('else');
    expect(labels).toContain('switch (e.kind)');
    expect(labels).toContain('case "x":');
    expect(labels).toContain('case "y":');
  });

  it('ignores deeply nested if/switch', () => {
    const src = [
      'function run(e) {',
      '  if (x) {',
      '    if (y) {',          // nested — should NOT appear
      '      doDeep();',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const labels = outline(src).map((o) => o.label);
    expect(labels).toContain('if (x)');
    expect(labels).not.toContain('if (y)');
  });
});
```

- [ ] **Step 2: Run; expect FAIL**

- [ ] **Step 3: Implement**

```ts
// client/src/components/transforms-inspector/outline.ts
/**
 * Regex-based structural outliner for read-only transform source. Two
 * levels of recognition:
 *
 *   1. Top-level declarations — `(export )?(function|const)\s+name…`.
 *   2. Top-level branches inside a `run` body — lines that start with
 *      exactly two-space indent (`^\s{2}`) and begin with `if (`,
 *      `else if (`, `else`, `switch (`, or `case …:`.
 *
 * Anything more deeply nested is ignored on purpose — this is a navigation
 * aid, not an AST.
 */

export interface OutlineEntry {
  line: number; // 1-based
  label: string;
  kind: 'decl' | 'branch';
}

const DECL_RE = /^(?:export\s+)?(function\s+\w+\s*\([^)]*\)|const\s+\w+)/;
const BRANCH_RE = /^ {2}(if\s*\([^)]*\)|else\s+if\s*\([^)]*\)|else|switch\s*\([^)]*\)|case\s+[^:]+:)/;

export function outline(src: string): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const declMatch = raw.match(DECL_RE);
    if (declMatch) {
      out.push({ line: i + 1, label: declMatch[1] ?? raw.trim(), kind: 'decl' });
      continue;
    }
    const branchMatch = raw.match(BRANCH_RE);
    if (branchMatch) {
      out.push({ line: i + 1, label: branchMatch[1] ?? raw.trim(), kind: 'branch' });
    }
  }
  return out;
}
```

- [ ] **Step 4: Re-run tests; all pass**

- [ ] **Step 5: Commit**

```bash
git add client/src/components/transforms-inspector/outline.ts client/src/components/transforms-inspector/outline.test.ts
git commit -m "$(cat <<'EOF'
client(inspector): regex outline for read-only source view

Tops out at top-level declarations + first-level branches inside a run
body. Anything deeper is ignored on purpose.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Inference algorithm + tests

**Files:**
- Create: `client/src/components/transforms-inspector/inference.ts`
- Create: `client/src/components/transforms-inspector/inference.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// client/src/components/transforms-inspector/inference.test.ts
import { describe, expect, it } from 'vitest';
import type { Event } from '@server/parser.ts';
import { infer } from './inference.ts';

function mk(partial: Partial<Event> & { kind: string }): Event {
  return {
    uuid: 'u',
    parent_uuid: null,
    session_id: 's',
    ts: 0,
    ...partial,
  } as unknown as Event;
}

describe('infer()', () => {
  it('falls back to event[kind=...] for unknown kinds', () => {
    expect(infer(mk({ kind: 'mystery', payload: {} } as any))).toBe('event[kind=mystery]');
  });

  it('adds a tool_use[name=...] segment when tool_use has a name', () => {
    const out = infer(
      mk({ kind: 'tool_use', payload: { tool_use_id: 't', name: 'Bash', input: {} } } as any),
    );
    expect(out).toBe('event[kind=tool_use] > tool_use[name=Bash]');
  });

  it('emits a plain tool_result segment', () => {
    const out = infer(
      mk({ kind: 'tool_result', payload: { tool_use_id: 't', content: '', is_error: false } } as any),
    );
    expect(out).toBe('event[kind=tool_result] > tool_result');
  });

  it('detects a <bash-input> marker on user_text', () => {
    const out = infer(
      mk({ kind: 'user_text', payload: { text: '<bash-input>ls</bash-input>' } } as any),
    );
    expect(out).toBe('event[kind=user_text] > text[contains=<bash-input]');
  });

  it('detects a <bh-title> marker on assistant_text', () => {
    const out = infer(
      mk({ kind: 'assistant_text', payload: { text: 'hi <bh-title>x</bh-title>' } } as any),
    );
    expect(out).toBe('event[kind=assistant_text] > text[contains=<bh-title]');
  });

  it('adds meta[kind=...] when meta payload carries a kind', () => {
    const out = infer(
      mk({ kind: 'meta', payload: { kind: 'queue-operation' } } as any),
    );
    expect(out).toBe('event[kind=meta] > meta[kind=queue-operation]');
  });

  it('emits bare event[kind=meta] when no meta kind is present', () => {
    expect(infer(mk({ kind: 'meta', payload: {} } as any))).toBe('event[kind=meta]');
  });
});
```

- [ ] **Step 2: Run; expect FAIL.**

- [ ] **Step 3: Implement**

```ts
// client/src/components/transforms-inspector/inference.ts
/**
 * Draft-selector inference for the point-and-build authoring path. Walks
 * the event's `kind` + `payload` shape and emits a `event[kind=…] > …`
 * source string the engine can parse. v1 keeps the grammar minimal — the
 * user gets a head start, not a finished selector.
 */

import type { Event } from '@server/parser.ts';

const TEXT_MARKERS = ['bash-input', 'bh-title', 'task-notification', 'brainhouse-checklist'];

export function infer(e: Event): string {
  const parts = [`event[kind=${e.kind}]`];
  const payload = (e as { payload?: Record<string, unknown> }).payload ?? {};
  switch (e.kind) {
    case 'tool_use': {
      const name = (payload as { name?: unknown }).name;
      if (typeof name === 'string' && name.length > 0) {
        parts.push(`tool_use[name=${name}]`);
      }
      break;
    }
    case 'tool_result': {
      if ((payload as { tool_use_id?: unknown }).tool_use_id) {
        parts.push('tool_result');
      }
      break;
    }
    case 'user_text':
    case 'assistant_text': {
      const text = (payload as { text?: unknown }).text;
      if (typeof text === 'string') {
        for (const tag of TEXT_MARKERS) {
          if (text.includes(`<${tag}`)) {
            parts.push(`text[contains=<${tag}]`);
            break;
          }
        }
      }
      break;
    }
    case 'meta': {
      const metaKind = (payload as { kind?: unknown }).kind;
      if (typeof metaKind === 'string' && metaKind.length > 0) {
        parts.push(`meta[kind=${metaKind}]`);
      }
      break;
    }
  }
  return parts.join(' > ');
}
```

- [ ] **Step 4: Re-run; all pass.**

- [ ] **Step 5: Commit**

```bash
git add client/src/components/transforms-inspector/inference.ts client/src/components/transforms-inspector/inference.test.ts
git commit -m "$(cat <<'EOF'
client(inspector): pure infer() for point-and-build selectors

Branches per event.kind; falls back to event[kind=<x>] for unknown
kinds. Output is a hint — the user can rewrite freely in the sheet.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Hash-route hook

**Files:**
- Create: `client/src/components/transforms-inspector/useHashRoute.ts`

- [ ] **Step 1: Implement**

```ts
// client/src/components/transforms-inspector/useHashRoute.ts
/**
 * Two-way binding for the inspector's URL hash so deep-links + cross-tab
 * navigation are just hash mutations. Hash format:
 *
 *   #inspector/<tab>/<key>
 *
 * `tab` ∈ { 'types', 'transforms', 'trace' }. `key` is optional.
 *
 * Outside the inspector context (no `#inspector/` prefix), this hook is
 * a no-op reader — it returns `null` for both fields and `setRoute()`
 * still writes the hash.
 */

import { useCallback, useEffect, useState } from 'react';

export type InspectorTab = 'types' | 'transforms' | 'trace';

export interface InspectorRoute {
  tab: InspectorTab | null;
  key: string | null;
}

function parseHash(hash: string): InspectorRoute {
  // hash starts with '#'
  const m = hash.match(/^#inspector\/(types|transforms|trace)(?:\/(.+))?$/);
  if (!m) return { tab: null, key: null };
  return { tab: m[1] as InspectorTab, key: m[2] ? decodeURIComponent(m[2]) : null };
}

function serialize(route: InspectorRoute): string {
  if (!route.tab) return '';
  const base = `#inspector/${route.tab}`;
  return route.key ? `${base}/${encodeURIComponent(route.key)}` : base;
}

export function useHashRoute(initial: InspectorTab = 'types'): {
  route: InspectorRoute;
  setRoute: (next: InspectorRoute) => void;
} {
  const [route, setRouteState] = useState<InspectorRoute>(() => {
    const parsed = parseHash(window.location.hash);
    if (parsed.tab) return parsed;
    return { tab: initial, key: null };
  });

  useEffect(() => {
    const onHash = () => setRouteState(parseHash(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const setRoute = useCallback((next: InspectorRoute) => {
    const target = serialize(next);
    if (target !== window.location.hash) {
      window.history.replaceState(null, '', target || window.location.pathname);
    }
    setRouteState(next);
  }, []);

  return { route, setRoute };
}
```

- [ ] **Step 2: Commit**

```bash
git add client/src/components/transforms-inspector/useHashRoute.ts
git commit -m "$(cat <<'EOF'
client(inspector): URL-hash route for tab + selected key

`#inspector/<tab>/<key>` — deep links + cross-tab chip navigation share
one source of truth.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Shared chip component

**Files:**
- Create: `client/src/components/transforms-inspector/chips.tsx`

- [ ] **Step 1: Implement**

```tsx
// client/src/components/transforms-inspector/chips.tsx
/**
 * Compact chip rendering a selector key. Used in both Tab A's "Used by"
 * (jumps to Transforms tab) and Tab B's "Matches" list (jumps to Types
 * tab). When the key is missing from the store, the chip renders with a
 * trailing "?" badge and a tooltip — surfaces drift rather than hiding.
 */

import { useSelectors } from '../../transforms/selectors/store.tsx';

export function SelectorKeyChip({
  selectorKey,
  onClick,
}: {
  selectorKey: string;
  onClick?: () => void;
}) {
  const { byKey } = useSelectors();
  const def = byKey.get(selectorKey);
  const missing = !def;
  return (
    <button
      type="button"
      className={`inspector-chip${missing ? ' inspector-chip-missing' : ''}`}
      onClick={onClick}
      title={missing ? 'selector not in registry' : def!.description || selectorKey}
    >
      <span className="inspector-chip-key">{selectorKey}</span>
      {missing && <span className="inspector-chip-badge" aria-label="missing selector">?</span>}
    </button>
  );
}

export function TransformKeyChip({
  transformKey,
  name,
  onClick,
}: {
  transformKey: string;
  name?: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className="inspector-chip"
      onClick={onClick}
      title={transformKey}
    >
      <span className="inspector-chip-key">{name ?? transformKey}</span>
    </button>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add client/src/components/transforms-inspector/chips.tsx
git commit -m "$(cat <<'EOF'
client(inspector): shared chip primitives for selector/transform keys

A missing-selector chip stamps a `?` badge so registry drift surfaces
instead of hiding.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: `SourceView` component + story

**Files:**
- Create: `client/src/components/transforms-inspector/SourceView.tsx`
- Create: `client/src/components/transforms-inspector/SourceView.stories.tsx`

- [ ] **Step 1: Implement**

`highlight.js` is already a dep (`client/package.json:30`). Use its
`typescript` language pack:

```tsx
// client/src/components/transforms-inspector/SourceView.tsx
/**
 * Read-only TypeScript source block with a left-rail structural outline.
 * Clicking an outline entry scrolls the `<pre>` to that line. Highlight
 * via highlight.js (already a project dep); on parse failure, fall back
 * to plain text.
 */

import hljs from 'highlight.js/lib/core';
import typescript from 'highlight.js/lib/languages/typescript';
import { useEffect, useMemo, useRef } from 'react';
import { outline, type OutlineEntry } from './outline.ts';

hljs.registerLanguage('typescript', typescript);

export function SourceView({ source }: { source: string }) {
  const entries: OutlineEntry[] = useMemo(() => outline(source), [source]);
  const html = useMemo(() => {
    try {
      return hljs.highlight(source, { language: 'typescript' }).value;
    } catch {
      return escapeHtml(source);
    }
  }, [source]);
  const preRef = useRef<HTMLPreElement>(null);

  const scrollTo = (line: number) => {
    const pre = preRef.current;
    if (!pre) return;
    // Each rendered <span class="src-line"> tags itself with data-line.
    const target = pre.querySelector<HTMLElement>(`[data-line="${line}"]`);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // Wrap highlighted HTML one line per row so the outline can address rows
  // by line number. We split on '\n' AFTER highlighting; highlight.js never
  // emits a newline inside a `<span>` tag, so the split is safe.
  const lineHtml = useMemo(() => {
    return html
      .split('\n')
      .map((ln, i) => `<span class="src-line" data-line="${i + 1}">${ln || ' '}</span>`)
      .join('\n');
  }, [html]);

  useEffect(() => {
    // No-op effect; placeholder if we later need to refresh on source change.
  }, [source]);

  return (
    <div className="inspector-source">
      <nav className="inspector-source-outline" aria-label="Source outline">
        {entries.length === 0 ? (
          <span className="inspector-source-outline-empty">no outline</span>
        ) : (
          <ul>
            {entries.map((e) => (
              <li key={`${e.line}-${e.label}`} className={`inspector-outline-${e.kind}`}>
                <button type="button" onClick={() => scrollTo(e.line)}>
                  <span className="inspector-outline-line">L{e.line}</span>
                  <span className="inspector-outline-label">{e.label}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </nav>
      <pre ref={preRef} className="inspector-source-code">
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: highlight.js sanitizes its own output */}
        <code className="hljs language-typescript" dangerouslySetInnerHTML={{ __html: lineHtml }} />
      </pre>
    </div>
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
```

- [ ] **Step 2: Story**

```tsx
// client/src/components/transforms-inspector/SourceView.stories.tsx
import { SourceView } from './SourceView.tsx';

const SHORT = `export const trackPending = {
  key: 'trackPending',
  run(event, items, ctx) {
    if (event.kind === 'user_text') ctx.scratch.pending = true;
  },
};
`;

const LONG = Array.from({ length: 40 }, (_, i) => `// line ${i + 1}`).join('\n');

const BRANCHY = `export function run(e) {
  if (e.kind === 'tool_use') {
    if (e.payload.name === 'Bash') return false;
  } else if (e.kind === 'tool_result') {
    return false;
  } else {
    return true;
  }
  switch (e.kind) {
    case 'meta':
      return false;
    case 'system':
      return false;
  }
}
`;

export const Short = () => (
  <div style={{ width: 760, padding: '1rem' }}>
    <SourceView source={SHORT} />
  </div>
);

export const Long = () => (
  <div style={{ width: 760, padding: '1rem' }}>
    <SourceView source={LONG} />
  </div>
);

export const OutlineManyBranches = () => (
  <div style={{ width: 760, padding: '1rem' }}>
    <SourceView source={BRANCHY} />
  </div>
);
```

Note: stories use inline `style` only for canvas framing — that's the
established convention in the repo's other `.stories.tsx` files (see
`TransformsModal.stories.tsx`, `FileChangeLightbox.stories.tsx`). Inline
styles in production component code are forbidden; stories are a known
allowance.

- [ ] **Step 3: Commit**

```bash
git add client/src/components/transforms-inspector/SourceView.tsx client/src/components/transforms-inspector/SourceView.stories.tsx
git commit -m "$(cat <<'EOF'
client(inspector): SourceView with outline + highlight.js TS coloring

Lines are individually addressable so the outline can scroll-to. Falls
back to plain text on highlight error.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Types tab (list + detail) + tests + story

**Files:**
- Create: `client/src/components/transforms-inspector/TypesList.tsx`
- Create: `client/src/components/transforms-inspector/TypesDetail.tsx`
- Create: `client/src/components/transforms-inspector/TypesTab.tsx`
- Create: `client/src/components/transforms-inspector/TypesTab.test.tsx`
- Create: `client/src/components/transforms-inspector/TypesDetail.stories.tsx`

- [ ] **Step 1: TypesList component**

```tsx
// client/src/components/transforms-inspector/TypesList.tsx
/** Left column for the Types tab — search + selectable row per SelectorDef. */

import type { StoredSelectorDef } from '../../transforms/selectors/store.tsx';

export function TypesList({
  entries,
  selectedKey,
  search,
  onSearch,
  onSelect,
  onAdd,
}: {
  entries: StoredSelectorDef[];
  selectedKey: string | null;
  search: string;
  onSearch: (s: string) => void;
  onSelect: (key: string) => void;
  onAdd: () => void;
}) {
  return (
    <div className="inspector-list">
      <div className="inspector-list-header">
        <input
          type="search"
          placeholder="search types…"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          className="inspector-search"
        />
        <button type="button" className="inspector-add" onClick={onAdd}>
          + Add type
        </button>
      </div>
      {entries.length === 0 && <p className="inspector-list-empty">no matches</p>}
      <ul className="inspector-list-rows">
        {entries.map((s) => (
          <li key={s.key}>
            <button
              type="button"
              className={`inspector-list-row${s.key === selectedKey ? ' is-selected' : ''}`}
              onClick={() => onSelect(s.key)}
            >
              <span className="inspector-list-name">
                {s.name}
                {s.origin === 'user' && <span className="inspector-badge-user">user</span>}
              </span>
              <span className="inspector-list-key">{s.key}</span>
              <span className="inspector-list-desc">{s.description}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: TypesDetail component**

```tsx
// client/src/components/transforms-inspector/TypesDetail.tsx
/** Right column for the Types tab — full SelectorDef with cross-link chips. */

import type { ViewTransform } from '../../transforms/types.ts';
import type { StoredSelectorDef } from '../../transforms/selectors/store.tsx';
import { TransformKeyChip } from './chips.tsx';
import { SourceView } from './SourceView.tsx';

export function TypesDetail({
  def,
  usedBy,
  onJumpToTransform,
}: {
  def: StoredSelectorDef | null;
  usedBy: ViewTransform[];
  onJumpToTransform: (transformKey: string) => void;
}) {
  if (!def) {
    return (
      <div className="inspector-detail inspector-detail-empty">
        <p>Select a type to inspect.</p>
      </div>
    );
  }
  let prettySample = '';
  if (def.samplePayload !== undefined) {
    try {
      prettySample = JSON.stringify(def.samplePayload, null, 2);
    } catch {
      prettySample = String(def.samplePayload);
    }
  }
  return (
    <div className="inspector-detail">
      <header className="inspector-detail-header">
        <h4 className="inspector-detail-name">{def.name}</h4>
        <code className="inspector-detail-key">{def.key}</code>
        {def.origin === 'user' && <span className="inspector-badge-user">user</span>}
      </header>
      {def.description && <p className="inspector-detail-desc">{def.description}</p>}
      <section className="inspector-detail-section">
        <h5>Selector source</h5>
        <SourceView source={def.selector} />
      </section>
      <section className="inspector-detail-section">
        <h5>Sample payload</h5>
        {prettySample ? (
          <pre className="inspector-sample">{prettySample}</pre>
        ) : (
          <p className="inspector-muted">(no sample payload — attach one in point-and-build)</p>
        )}
      </section>
      <section className="inspector-detail-section">
        <h5>Used by</h5>
        {usedBy.length === 0 ? (
          <p className="inspector-muted">(no transform declares this type)</p>
        ) : (
          <div className="inspector-chip-row">
            {usedBy.map((t) => (
              <TransformKeyChip
                key={t.key}
                transformKey={t.key}
                name={t.name}
                onClick={() => onJumpToTransform(t.key)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 3: TypesTab controller**

```tsx
// client/src/components/transforms-inspector/TypesTab.tsx
/** Tab A controller. Owns search state; reads selection from props (hash route). */

import { useMemo, useState } from 'react';
import { VIEW_TRANSFORMS } from '../../transforms/registry.ts';
import { useSelectors } from '../../transforms/selectors/store.tsx';
import { TypeAuthoringSheet } from './TypeAuthoringSheet.tsx';
import { TypesDetail } from './TypesDetail.tsx';
import { TypesList } from './TypesList.tsx';

export function TypesTab({
  selectedKey,
  onSelect,
  onJumpToTransform,
}: {
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  onJumpToTransform: (transformKey: string) => void;
}) {
  const { all, byKey, addUser } = useSelectors();
  const [search, setSearch] = useState('');
  const [authoring, setAuthoring] = useState(false);

  const filtered = useMemo(() => {
    const sorted = [...all].sort((a, b) => a.key.localeCompare(b.key));
    if (!search) return sorted;
    const q = search.toLowerCase();
    return sorted.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.key.toLowerCase().includes(q) ||
        s.selector.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q),
    );
  }, [all, search]);

  const selected = selectedKey ? byKey.get(selectedKey) ?? null : null;
  const usedBy = useMemo(() => {
    if (!selected) return [];
    return VIEW_TRANSFORMS.filter((t) => t.matches?.includes(selected.key));
  }, [selected]);

  return (
    <div className="inspector-two-col">
      <TypesList
        entries={filtered}
        selectedKey={selectedKey}
        search={search}
        onSearch={setSearch}
        onSelect={onSelect}
        onAdd={() => setAuthoring(true)}
      />
      {authoring ? (
        <TypeAuthoringSheet
          onCancel={() => setAuthoring(false)}
          onSave={(def) => {
            addUser(def);
            setAuthoring(false);
            onSelect(def.key);
          }}
        />
      ) : (
        <TypesDetail
          def={selected}
          usedBy={usedBy}
          onJumpToTransform={onJumpToTransform}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 4: TypesDetail story**

```tsx
// client/src/components/transforms-inspector/TypesDetail.stories.tsx
import { SelectorStoreProvider } from '../../transforms/selectors/store.tsx';
import type { ViewTransform } from '../../transforms/types.ts';
import { TypesDetail } from './TypesDetail.tsx';
import type { StoredSelectorDef } from '../../transforms/selectors/store.tsx';

function frame(children: React.ReactNode) {
  return (
    <SelectorStoreProvider>
      <div style={{ width: 720, padding: '1rem' }}>{children}</div>
    </SelectorStoreProvider>
  );
}

const WITH_SAMPLE: StoredSelectorDef = {
  origin: 'builtin',
  key: 'tool-use.todowrite',
  name: 'TodoWrite tool_use',
  description: 'A tool_use event whose tool name is exactly "TodoWrite".',
  selector: 'event[kind=tool_use] > tool_use[name=TodoWrite]',
  samplePayload: { kind: 'tool_use', payload: { name: 'TodoWrite', input: { todos: [] } } },
};

const WITHOUT_SAMPLE: StoredSelectorDef = {
  origin: 'builtin',
  key: 'assistant-text.bh-title',
  name: 'Assistant <bh-title> marker',
  description: 'An assistant_text event with a trailing <bh-title>…</bh-title> marker.',
  selector: 'event[kind=assistant_text] > text[contains=<bh-title]',
};

const FAKE_TRANSFORMS: ViewTransform[] = Array.from({ length: 4 }).map((_, i) => ({
  key: `fake-${i}`,
  name: `fake transform ${i}`,
  description: '',
  kind: 'view',
  stage: 1,
  run: () => false,
})) as unknown as ViewTransform[];

export const WithSample = () => frame(<TypesDetail def={WITH_SAMPLE} usedBy={[]} onJumpToTransform={() => {}} />);
export const WithoutSample = () => frame(<TypesDetail def={WITHOUT_SAMPLE} usedBy={[]} onJumpToTransform={() => {}} />);
export const ManyRelatedTransforms = () =>
  frame(<TypesDetail def={WITH_SAMPLE} usedBy={FAKE_TRANSFORMS} onJumpToTransform={() => {}} />);
export const NoRelatedTransforms = () =>
  frame(<TypesDetail def={WITH_SAMPLE} usedBy={[]} onJumpToTransform={() => {}} />);
```

- [ ] **Step 5: TypesTab test**

```tsx
// client/src/components/transforms-inspector/TypesTab.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SelectorStoreProvider } from '../../transforms/selectors/store.tsx';
import { TypesTab } from './TypesTab.tsx';

function renderTab(props: Partial<React.ComponentProps<typeof TypesTab>> = {}) {
  const onSelect = vi.fn();
  const onJump = vi.fn();
  const utils = render(
    <SelectorStoreProvider>
      <TypesTab selectedKey={null} onSelect={onSelect} onJumpToTransform={onJump} {...props} />
    </SelectorStoreProvider>,
  );
  return { ...utils, onSelect, onJump };
}

describe('<TypesTab>', () => {
  it('filters rows by name/key/selector source', () => {
    renderTab();
    const initialRows = screen.getAllByRole('button', { name: /tool-use|user-text|assistant-text|meta/ });
    expect(initialRows.length).toBeGreaterThan(0);

    fireEvent.change(screen.getByPlaceholderText(/search types/i), {
      target: { value: 'todowrite' },
    });
    const filtered = screen.getAllByRole('button', { name: /todowrite/i });
    expect(filtered.length).toBeGreaterThan(0);
    expect(screen.queryByText(/queue-operation/i)).not.toBeInTheDocument();
  });

  it('calls onSelect when a row is clicked', () => {
    const { onSelect } = renderTab();
    const row = screen.getByText('Bash tool_use').closest('button')!;
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith('tool-use.bash');
  });

  it('renders the detail empty state when nothing is selected', () => {
    renderTab();
    expect(screen.getByText(/select a type/i)).toBeInTheDocument();
  });

  it('renders the detail panel for a selected key', () => {
    renderTab({ selectedKey: 'tool-use.bash' });
    expect(screen.getByRole('heading', { name: 'Bash tool_use' })).toBeInTheDocument();
  });
});
```

- [ ] **Step 6: Run tests, expect FAIL on auth-sheet missing**

We haven't written `TypeAuthoringSheet` yet. Two options: create a tiny
stub now (so the import resolves) and finish it in Task 13, OR write
Task 13 first. Pick the stub:

```tsx
// client/src/components/transforms-inspector/TypeAuthoringSheet.tsx (temporary stub; replaced in Task 13)
import type { SelectorDef } from '../../transforms/selectors/index.ts';
export function TypeAuthoringSheet({
  onCancel,
  onSave: _onSave,
}: {
  onCancel: () => void;
  onSave: (def: SelectorDef) => void;
}) {
  return (
    <div className="inspector-detail">
      <p>authoring stub</p>
      <button type="button" onClick={onCancel}>Cancel</button>
    </div>
  );
}
```

Run tests now:

```
cd client && npx vitest run src/components/transforms-inspector/TypesTab.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add client/src/components/transforms-inspector/TypesList.tsx client/src/components/transforms-inspector/TypesDetail.tsx client/src/components/transforms-inspector/TypesTab.tsx client/src/components/transforms-inspector/TypesTab.test.tsx client/src/components/transforms-inspector/TypesDetail.stories.tsx client/src/components/transforms-inspector/TypeAuthoringSheet.tsx
git commit -m "$(cat <<'EOF'
client(inspector): Types tab (list + detail + sheet stub)

Search filters across name/key/source/description; "Used by" links into
the Transforms tab. Authoring sheet wired as a stub; full impl lands in
the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: `TypeAuthoringSheet` (point-and-build + raw) + tests + story

**Files:**
- Modify: `client/src/components/transforms-inspector/TypeAuthoringSheet.tsx` (replace stub)
- Create: `client/src/components/transforms-inspector/TypeAuthoringSheet.test.tsx`
- Create: `client/src/components/transforms-inspector/TypeAuthoringSheet.stories.tsx`

The sheet needs an event source. For Spec 2 we accept a `recentEvents`
prop (default `[]`); the top-level inspector wires the events from
the currently focused panel later. For v1 the inspector will pass
`[]` — pick-an-event will show "(no events…)" and the user can paste
JSON or write a raw selector.

- [ ] **Step 1: Implement the sheet**

```tsx
// client/src/components/transforms-inspector/TypeAuthoringSheet.tsx
/**
 * Point-and-build (pick an event from the panel, infer a selector) or
 * write a raw selector. v1 has no event list wiring — see Spec 2 modal
 * shell; events default to []. Save is rejected unless the key is
 * `user.`-prefixed and unique.
 */

import { useMemo, useState } from 'react';
import type { Event } from '@server/parser.ts';
import { compileSelector, type SelectorDef } from '../../transforms/selectors/index.ts';
import { infer } from './inference.ts';

type Path = 'pick' | 'paste' | 'raw';

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

export function TypeAuthoringSheet({
  recentEvents = [],
  onCancel,
  onSave,
}: {
  recentEvents?: Event[];
  onCancel: () => void;
  onSave: (def: SelectorDef) => void;
}) {
  const [path, setPath] = useState<Path>('pick');
  const [selectedEventUuid, setSelectedEventUuid] = useState<string | null>(null);
  const [pasted, setPasted] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [key, setKey] = useState('');
  const [selectorSrc, setSelectorSrc] = useState('');
  const [error, setError] = useState<string | null>(null);

  const sampleEvent: Event | null = useMemo(() => {
    if (path === 'paste') {
      if (!pasted.trim()) return null;
      try {
        return JSON.parse(pasted) as Event;
      } catch {
        return null;
      }
    }
    if (path === 'pick' && selectedEventUuid) {
      return recentEvents.find((e) => e.uuid === selectedEventUuid) ?? null;
    }
    return null;
  }, [path, pasted, selectedEventUuid, recentEvents]);

  const inferredSrc = useMemo(() => {
    if (path === 'raw' || !sampleEvent) return '';
    return infer(sampleEvent);
  }, [sampleEvent, path]);

  // Default the editable selector source to the inferred one when the user
  // hasn't typed anything yet.
  const effectiveSelectorSrc = selectorSrc || inferredSrc;

  // Compile + match-check.
  const matchInfo = useMemo<'yes' | 'no' | '—' | 'err'>(() => {
    if (!effectiveSelectorSrc) return '—';
    if (!sampleEvent) return '—';
    try {
      const compiled = compileSelector(effectiveSelectorSrc);
      return compiled.match(sampleEvent) ? 'yes' : 'no';
    } catch {
      return 'err';
    }
  }, [effectiveSelectorSrc, sampleEvent]);

  const effectiveKey = key || (name ? `user.${slugify(name)}` : '');

  const handleSave = () => {
    setError(null);
    if (!name.trim()) {
      setError('name is required');
      return;
    }
    if (!effectiveKey.startsWith('user.')) {
      setError('key must start with "user."');
      return;
    }
    if (!effectiveSelectorSrc.trim()) {
      setError('selector source is required');
      return;
    }
    try {
      onSave({
        key: effectiveKey,
        name,
        description,
        selector: effectiveSelectorSrc,
        samplePayload: sampleEvent ?? undefined,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="inspector-detail inspector-sheet">
      <header className="inspector-detail-header">
        <h4>Add type</h4>
        <button type="button" className="inspector-sheet-cancel" onClick={onCancel}>
          Cancel
        </button>
      </header>
      <nav className="inspector-sheet-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={path === 'pick'}
          className={path === 'pick' ? 'is-active' : ''}
          onClick={() => setPath('pick')}
        >
          Pick an event
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={path === 'paste'}
          className={path === 'paste' ? 'is-active' : ''}
          onClick={() => setPath('paste')}
        >
          Paste JSON
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={path === 'raw'}
          className={path === 'raw' ? 'is-active' : ''}
          onClick={() => setPath('raw')}
        >
          Write selector
        </button>
      </nav>

      {path === 'pick' && (
        <section className="inspector-sheet-source">
          {recentEvents.length === 0 ? (
            <p className="inspector-muted">
              (no events in the current panel — paste JSON or write a raw selector)
            </p>
          ) : (
            <select
              className="inspector-event-picker"
              value={selectedEventUuid ?? ''}
              onChange={(e) => setSelectedEventUuid(e.target.value || null)}
            >
              <option value="">— select an event —</option>
              {recentEvents.slice(0, 200).map((ev) => (
                <option key={ev.uuid} value={ev.uuid}>
                  {ev.kind} · {ev.uuid.slice(0, 6)}
                </option>
              ))}
            </select>
          )}
        </section>
      )}

      {path === 'paste' && (
        <section className="inspector-sheet-source">
          <textarea
            className="inspector-paste-area"
            placeholder='{"kind":"tool_use","payload":{"name":"Bash",...}}'
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
          />
        </section>
      )}

      {(path === 'pick' || path === 'paste') && sampleEvent && (
        <section className="inspector-detail-section">
          <h5>Event</h5>
          <pre className="inspector-sample">{JSON.stringify(sampleEvent, null, 2)}</pre>
        </section>
      )}

      <section className="inspector-detail-section">
        <h5>Selector source</h5>
        <input
          type="text"
          className="inspector-field"
          placeholder={path === 'raw' ? 'event[kind=…] > …' : inferredSrc || 'event[kind=…]'}
          value={selectorSrc}
          onChange={(e) => setSelectorSrc(e.target.value)}
        />
        <p className="inspector-match-info">
          Matches sample? <strong>{matchInfo}</strong>
        </p>
      </section>

      <section className="inspector-detail-section inspector-sheet-meta">
        <label>
          <span>Name</span>
          <input
            type="text"
            className="inspector-field"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          <span>Key</span>
          <input
            type="text"
            className="inspector-field"
            placeholder={effectiveKey || 'user.…'}
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </label>
        <label>
          <span>Description</span>
          <input
            type="text"
            className="inspector-field"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
      </section>

      {error && <p className="inspector-error">{error}</p>}

      <footer className="inspector-sheet-footer">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="inspector-primary" onClick={handleSave}>
          Save
        </button>
      </footer>
    </div>
  );
}
```

- [ ] **Step 2: Test**

```tsx
// client/src/components/transforms-inspector/TypeAuthoringSheet.test.tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Event } from '@server/parser.ts';
import { SelectorStoreProvider } from '../../transforms/selectors/store.tsx';
import { TypeAuthoringSheet } from './TypeAuthoringSheet.tsx';

const FAKE_EVENT: Event = {
  uuid: 'abc123def456',
  parent_uuid: null,
  session_id: 's',
  ts: 0,
  kind: 'tool_use',
  payload: { tool_use_id: 't', name: 'Bash', input: {} },
} as unknown as Event;

function frame(props: Partial<React.ComponentProps<typeof TypeAuthoringSheet>> = {}) {
  return render(
    <SelectorStoreProvider>
      <TypeAuthoringSheet
        recentEvents={[]}
        onCancel={vi.fn()}
        onSave={vi.fn()}
        {...props}
      />
    </SelectorStoreProvider>,
  );
}

describe('<TypeAuthoringSheet>', () => {
  it('shows the empty-events hint when pick is active and no events are passed', () => {
    frame();
    expect(screen.getByText(/no events in the current panel/i)).toBeInTheDocument();
  });

  it('picking an event populates the workbench with an inferred selector', () => {
    frame({ recentEvents: [FAKE_EVENT] });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'abc123def456' } });
    expect(screen.getByText(/Matches sample\?/)).toBeInTheDocument();
    // Inferred selector is shown as a placeholder, even with no text typed.
    const fields = screen.getAllByRole('textbox');
    // First text field is the selector source.
    expect(fields[0]).toHaveAttribute(
      'placeholder',
      'event[kind=tool_use] > tool_use[name=Bash]',
    );
  });

  it('Save errors out when name is missing', () => {
    const onSave = vi.fn();
    frame({ onSave });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText(/name is required/i)).toBeInTheDocument();
  });

  it('Save calls onSave with a `user.` key derived from name', () => {
    const onSave = vi.fn();
    frame({ recentEvents: [FAKE_EVENT], onSave });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'abc123def456' } });
    const [, nameInput] = screen.getAllByRole('textbox');
    // Selector source field is first; we want the "Name" field which is the
    // second textbox in the meta section. Order of inputs in the DOM (from
    // implementation): selector src, name, key, description.
    fireEvent.change(nameInput!, { target: { value: 'My Selector' } });
    // Type a selector source so the validator doesn't trip on empty source.
    fireEvent.change(screen.getAllByRole('textbox')[0]!, {
      target: { value: 'event[kind=tool_use]' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).toMatchObject({
      key: 'user.my-selector',
      name: 'My Selector',
      selector: 'event[kind=tool_use]',
    });
  });
});
```

- [ ] **Step 3: Story**

```tsx
// client/src/components/transforms-inspector/TypeAuthoringSheet.stories.tsx
import { SelectorStoreProvider } from '../../transforms/selectors/store.tsx';
import type { Event } from '@server/parser.ts';
import { TypeAuthoringSheet } from './TypeAuthoringSheet.tsx';

const EVENTS: Event[] = [
  {
    uuid: 'evt-1',
    parent_uuid: null,
    session_id: 's',
    ts: 0,
    kind: 'tool_use',
    payload: { tool_use_id: 't1', name: 'Bash', input: { command: 'ls' } },
  } as unknown as Event,
  {
    uuid: 'evt-2',
    parent_uuid: null,
    session_id: 's',
    ts: 1,
    kind: 'user_text',
    payload: { text: '<bash-input>pwd</bash-input>' },
  } as unknown as Event,
];

function frame(children: React.ReactNode) {
  return (
    <SelectorStoreProvider>
      <div style={{ width: 720, padding: '1rem' }}>{children}</div>
    </SelectorStoreProvider>
  );
}

export const PickAnEvent = () =>
  frame(<TypeAuthoringSheet recentEvents={EVENTS} onCancel={() => {}} onSave={() => {}} />);

export const PasteJsonFlow = () =>
  frame(<TypeAuthoringSheet recentEvents={[]} onCancel={() => {}} onSave={() => {}} />);

export const RawSelectorFlow = () =>
  frame(<TypeAuthoringSheet recentEvents={[]} onCancel={() => {}} onSave={() => {}} />);

export const SaveErrorKeyCollision = () => {
  return frame(
    <TypeAuthoringSheet
      recentEvents={EVENTS}
      onCancel={() => {}}
      onSave={(def) => {
        // Force the error path by throwing a fake collision error.
        throw new Error(`key "${def.key}" collides with a built-in selector`);
      }}
    />,
  );
};
```

- [ ] **Step 4: Run tests, expect PASS**

```
cd client && npx vitest run src/components/transforms-inspector/TypeAuthoringSheet.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add client/src/components/transforms-inspector/TypeAuthoringSheet.tsx client/src/components/transforms-inspector/TypeAuthoringSheet.test.tsx client/src/components/transforms-inspector/TypeAuthoringSheet.stories.tsx
git commit -m "$(cat <<'EOF'
client(inspector): TypeAuthoringSheet (pick / paste / raw)

Three entry paths share a workbench: editable selector source with
live match indicator + name/key/description. Save derives a slugged
user.<name> key when none is typed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: Transforms tab (list + detail) + tests + stories

**Files:**
- Create: `client/src/components/transforms-inspector/TransformsList.tsx`
- Create: `client/src/components/transforms-inspector/TransformsDetail.tsx`
- Create: `client/src/components/transforms-inspector/TransformsTab.tsx`
- Create: `client/src/components/transforms-inspector/TransformsTab.test.tsx`
- Create: `client/src/components/transforms-inspector/TransformsDetail.stories.tsx`

- [ ] **Step 1: TransformsList**

```tsx
// client/src/components/transforms-inspector/TransformsList.tsx
import type { ViewTransform } from '../../transforms/types.ts';

const MAX_VISIBLE_CHIPS = 2;

export function TransformsList({
  entries,
  selectedKey,
  search,
  onSearch,
  onSelect,
}: {
  entries: ViewTransform[];
  selectedKey: string | null;
  search: string;
  onSearch: (s: string) => void;
  onSelect: (key: string) => void;
}) {
  return (
    <div className="inspector-list">
      <div className="inspector-list-header">
        <input
          type="search"
          placeholder="search transforms…"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          className="inspector-search"
        />
      </div>
      <ul className="inspector-list-rows">
        {entries.map((t) => {
          const matches = t.matches ?? [];
          const visible = matches.slice(0, MAX_VISIBLE_CHIPS);
          const overflow = matches.length - visible.length;
          const views = t.views ? t.views.join(', ') : 'all';
          return (
            <li key={t.key}>
              <button
                type="button"
                className={`inspector-list-row inspector-transforms-row${
                  t.key === selectedKey ? ' is-selected' : ''
                }`}
                onClick={() => onSelect(t.key)}
              >
                <span className="inspector-list-name">{t.name}</span>
                <span className="inspector-list-key">{t.key}</span>
                <span className={`inspector-stage inspector-stage-${t.stage}`}>
                  stage {t.stage}
                </span>
                <span className="inspector-views">{views}</span>
                <span className="inspector-list-chips">
                  {visible.map((k) => (
                    <span key={k} className="inspector-chip-mini">{k}</span>
                  ))}
                  {overflow > 0 && <span className="inspector-chip-overflow">+{overflow}</span>}
                </span>
                <span className="inspector-list-desc">{t.description}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: TransformsDetail**

```tsx
// client/src/components/transforms-inspector/TransformsDetail.tsx
import type { ViewTransform } from '../../transforms/types.ts';
import { SelectorKeyChip } from './chips.tsx';
import { SourceView } from './SourceView.tsx';
import { TRANSFORM_SOURCE } from './sources.ts';

export function TransformsDetail({
  transform,
  onJumpToType,
}: {
  transform: ViewTransform | null;
  onJumpToType: (selectorKey: string) => void;
}) {
  if (!transform) {
    return (
      <div className="inspector-detail inspector-detail-empty">
        <p>Select a transform to inspect.</p>
      </div>
    );
  }
  const matches = transform.matches ?? [];
  const source = TRANSFORM_SOURCE[transform.key] ?? '';
  const views = transform.views ? transform.views.join(', ') : 'all';
  return (
    <div className="inspector-detail">
      <header className="inspector-detail-header">
        <h4 className="inspector-detail-name">{transform.name}</h4>
        <code className="inspector-detail-key">{transform.key}</code>
      </header>
      <div className="inspector-detail-meta">
        <span className={`inspector-stage inspector-stage-${transform.stage}`}>
          stage {transform.stage}
        </span>
        <span className="inspector-views">views: {views}</span>
      </div>
      {transform.description && (
        <p className="inspector-detail-desc">{transform.description}</p>
      )}
      <section className="inspector-detail-section">
        <h5>Matches</h5>
        {matches.length === 0 ? (
          <p className="inspector-muted">
            (no declared match — runs against every event)
          </p>
        ) : (
          <div className="inspector-chip-row">
            {matches.map((k) => (
              <SelectorKeyChip
                key={k}
                selectorKey={k}
                onClick={() => onJumpToType(k)}
              />
            ))}
          </div>
        )}
      </section>
      <section className="inspector-detail-section">
        <h5>Source</h5>
        {source ? (
          <SourceView source={source} />
        ) : (
          <p className="inspector-muted">(source not in manifest)</p>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 3: TransformsTab controller**

```tsx
// client/src/components/transforms-inspector/TransformsTab.tsx
import { useMemo, useState } from 'react';
import { VIEW_TRANSFORMS } from '../../transforms/registry.ts';
import { TransformsDetail } from './TransformsDetail.tsx';
import { TransformsList } from './TransformsList.tsx';

export function TransformsTab({
  selectedKey,
  onSelect,
  onJumpToType,
}: {
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  onJumpToType: (selectorKey: string) => void;
}) {
  const [search, setSearch] = useState('');
  const entries = useMemo(() => {
    if (!search) return VIEW_TRANSFORMS;
    const q = search.toLowerCase();
    return VIEW_TRANSFORMS.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.key.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        (t.matches ?? []).some((k) => k.toLowerCase().includes(q)),
    );
  }, [search]);
  const selected = selectedKey
    ? VIEW_TRANSFORMS.find((t) => t.key === selectedKey) ?? null
    : null;
  return (
    <div className="inspector-two-col">
      <TransformsList
        entries={entries}
        selectedKey={selectedKey}
        search={search}
        onSearch={setSearch}
        onSelect={onSelect}
      />
      <TransformsDetail transform={selected} onJumpToType={onJumpToType} />
    </div>
  );
}
```

- [ ] **Step 4: TransformsDetail story**

```tsx
// client/src/components/transforms-inspector/TransformsDetail.stories.tsx
import { SelectorStoreProvider } from '../../transforms/selectors/store.tsx';
import { VIEW_TRANSFORMS } from '../../transforms/registry.ts';
import { TransformsDetail } from './TransformsDetail.tsx';

function frame(children: React.ReactNode) {
  return (
    <SelectorStoreProvider>
      <div style={{ width: 720, padding: '1rem' }}>{children}</div>
    </SelectorStoreProvider>
  );
}

const stage1 = VIEW_TRANSFORMS.find((t) => t.stage === 1) ?? null;
const stage2 = VIEW_TRANSFORMS.find((t) => t.stage === 2) ?? null;

export const Stage1WithMatches = () => {
  // Synthesize matches so the story shows the chip row.
  const withMatches = stage1
    ? { ...stage1, matches: ['tool-use.bash', 'tool-use.todowrite'] as string[] }
    : null;
  return frame(<TransformsDetail transform={withMatches} onJumpToType={() => {}} />);
};

export const Stage2NoMatches = () =>
  frame(<TransformsDetail transform={stage2} onJumpToType={() => {}} />);

export const LongSource = () => {
  // Find a transform whose source is genuinely long (toolUseToCapsule or
  // todoWriteToChecklist tend to qualify).
  const long = VIEW_TRANSFORMS.find((t) => t.key === 'todoWriteToChecklist') ?? stage1;
  return frame(<TransformsDetail transform={long} onJumpToType={() => {}} />);
};
```

- [ ] **Step 5: TransformsTab test**

```tsx
// client/src/components/transforms-inspector/TransformsTab.test.tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SelectorStoreProvider } from '../../transforms/selectors/store.tsx';
import { TransformsTab } from './TransformsTab.tsx';

function renderTab(props: Partial<React.ComponentProps<typeof TransformsTab>> = {}) {
  const onSelect = vi.fn();
  const onJump = vi.fn();
  const utils = render(
    <SelectorStoreProvider>
      <TransformsTab selectedKey={null} onSelect={onSelect} onJumpToType={onJump} {...props} />
    </SelectorStoreProvider>,
  );
  return { ...utils, onSelect, onJump };
}

describe('<TransformsTab>', () => {
  it('lists VIEW_TRANSFORMS in registration order', () => {
    renderTab();
    // The first list row should be trackPending (top of registry).
    const rows = screen.getAllByRole('button');
    const firstName = rows.find((r) => r.textContent?.includes('trackPending'));
    expect(firstName).toBeDefined();
  });

  it('search filters by name and description', () => {
    renderTab();
    fireEvent.change(screen.getByPlaceholderText(/search transforms/i), {
      target: { value: 'coalesce' },
    });
    expect(screen.queryByText(/trackPending/)).not.toBeInTheDocument();
    expect(screen.getAllByText(/coalesce/i).length).toBeGreaterThan(0);
  });

  it('renders detail and shows "no declared match" until Spec 1 lands', () => {
    renderTab({ selectedKey: 'trackPending' });
    expect(screen.getByText(/no declared match/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 6: Run tests, expect PASS**

- [ ] **Step 7: Commit**

```bash
git add client/src/components/transforms-inspector/TransformsList.tsx client/src/components/transforms-inspector/TransformsDetail.tsx client/src/components/transforms-inspector/TransformsTab.tsx client/src/components/transforms-inspector/TransformsTab.test.tsx client/src/components/transforms-inspector/TransformsDetail.stories.tsx
git commit -m "$(cat <<'EOF'
client(inspector): Transforms tab (list + detail)

Detail panel cross-links match-key chips to the Types tab. Source view
hangs off the same ?raw manifest used by the drift test.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: Top-level `TransformsInspector` (tab strip + Trace placeholder) + story

**Files:**
- Create: `client/src/components/transforms-inspector/TransformsInspector.tsx`
- Create: `client/src/components/transforms-inspector/TransformsInspector.stories.tsx`

- [ ] **Step 1: Implement**

```tsx
// client/src/components/transforms-inspector/TransformsInspector.tsx
/**
 * Top-level inspector. Owns the tab strip (Types / Transforms / Trace) and
 * forwards hash-route state down to each tab. Trace renders a placeholder
 * card until Spec 3 ships.
 */

import { TransformsTab } from './TransformsTab.tsx';
import { TypesTab } from './TypesTab.tsx';
import { type InspectorTab, useHashRoute } from './useHashRoute.ts';

const TABS: { key: InspectorTab; label: string }[] = [
  { key: 'types', label: 'Types' },
  { key: 'transforms', label: 'Transforms' },
  { key: 'trace', label: 'Trace' },
];

export function TransformsInspector() {
  const { route, setRoute } = useHashRoute('types');
  const tab: InspectorTab = route.tab ?? 'types';
  const selectedKey = route.key;

  const setTab = (next: InspectorTab) => setRoute({ tab: next, key: null });
  const selectInTab = (next: InspectorTab, key: string | null) =>
    setRoute({ tab: next, key });

  return (
    <div className="transforms-inspector">
      <nav className="inspector-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={t.key === tab}
            className={`inspector-tab${t.key === tab ? ' is-active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
            {t.key === 'trace' && <span className="inspector-tab-soon">soon</span>}
          </button>
        ))}
      </nav>
      <div className="inspector-body">
        {tab === 'types' && (
          <TypesTab
            selectedKey={selectedKey}
            onSelect={(k) => selectInTab('types', k)}
            onJumpToTransform={(k) => selectInTab('transforms', k)}
          />
        )}
        {tab === 'transforms' && (
          <TransformsTab
            selectedKey={selectedKey}
            onSelect={(k) => selectInTab('transforms', k)}
            onJumpToType={(k) => selectInTab('types', k)}
          />
        )}
        {tab === 'trace' && (
          <div className="inspector-trace-placeholder">
            <h4>Live trace — coming in Spec 3</h4>
            <p className="inspector-muted">
              This tab will let you watch which transforms fire against which
              events as the panel runs. Tracked separately to keep the
              browse/author flows here shippable today.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Story**

```tsx
// client/src/components/transforms-inspector/TransformsInspector.stories.tsx
import { SelectorStoreProvider } from '../../transforms/selectors/store.tsx';
import { TransformsInspector } from './TransformsInspector.tsx';

function frame(children: React.ReactNode) {
  return (
    <SelectorStoreProvider>
      <div style={{ width: 960, padding: '1rem' }}>{children}</div>
    </SelectorStoreProvider>
  );
}

export const DefaultTypes = () => {
  window.location.hash = '#inspector/types';
  return frame(<TransformsInspector />);
};

export const TransformsTab = () => {
  window.location.hash = '#inspector/transforms';
  return frame(<TransformsInspector />);
};

export const TracePlaceholder = () => {
  window.location.hash = '#inspector/trace';
  return frame(<TransformsInspector />);
};
```

- [ ] **Step 3: Commit**

```bash
git add client/src/components/transforms-inspector/TransformsInspector.tsx client/src/components/transforms-inspector/TransformsInspector.stories.tsx
git commit -m "$(cat <<'EOF'
client(inspector): top-level shell — tab strip + hash routing

Trace tab renders a placeholder card; Spec 3 fills it in. Cross-tab
navigation is a hash mutation so the back button works.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 16: Swap `TransformsModal` body + update its test/story

**Files:**
- Modify: `client/src/components/TransformsModal.tsx`
- Modify: `client/src/components/TransformsModal.test.tsx`
- Modify: `client/src/components/TransformsModal.stories.tsx`

- [ ] **Step 1: Replace the modal body**

```tsx
// client/src/components/TransformsModal.tsx
/**
 * Outer modal shell for the pipeline inspector. The body is owned by
 * `<TransformsInspector />` (Spec 2: types + transforms browse; Spec 3:
 * live trace). Modal/lightbox/hotkey machinery is unchanged.
 */

import { TransformsInspector } from './transforms-inspector/TransformsInspector.tsx';

export function TransformsModal() {
  return (
    <div className="transforms-modal">
      <h3 className="lightbox-title">Pipeline inspector</h3>
      <TransformsInspector />
    </div>
  );
}
```

- [ ] **Step 2: Rewrite the test against the new shell**

```tsx
// client/src/components/TransformsModal.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SelectorStoreProvider } from '../transforms/selectors/store.tsx';
import { TransformsModal } from './TransformsModal.tsx';

function frame() {
  return render(
    <SelectorStoreProvider>
      <TransformsModal />
    </SelectorStoreProvider>,
  );
}

describe('<TransformsModal>', () => {
  it('renders the pipeline-inspector title', () => {
    frame();
    expect(screen.getByText(/pipeline inspector/i)).toBeInTheDocument();
  });

  it('renders the three inspector tabs including Trace', () => {
    frame();
    expect(screen.getByRole('tab', { name: /types/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /transforms/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /trace/i })).toBeInTheDocument();
  });

  it('Types tab is selected by default', () => {
    frame();
    expect(screen.getByRole('tab', { name: /types/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });
});
```

- [ ] **Step 3: Update the story to wrap with the provider**

```tsx
// client/src/components/TransformsModal.stories.tsx
import { SelectorStoreProvider } from '../transforms/selectors/store.tsx';
import { TransformsModal } from './TransformsModal.tsx';

export const Default = () => (
  <SelectorStoreProvider>
    <div style={{ width: 960, padding: '1rem', background: '#0f172a' }}>
      <TransformsModal />
    </div>
  </SelectorStoreProvider>
);
```

- [ ] **Step 4: Run the modal test, expect PASS**

```
cd client && npx vitest run src/components/TransformsModal.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add client/src/components/TransformsModal.tsx client/src/components/TransformsModal.test.tsx client/src/components/TransformsModal.stories.tsx
git commit -m "$(cat <<'EOF'
client: swap TransformsModal body for the new TransformsInspector

Outer modal shell + hotkey unchanged; the body is the tabbed inspector
from spec 2. Tests rewritten against the new shell.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 17: CSS — append inspector styles to `app.css`

**Files:**
- Modify: `client/src/app.css` (append)

Keep CSS classes only — no inline styles in production code, no `!important`.

- [ ] **Step 1: Append styles**

```css
/* ============================================================
 * Transforms inspector (Spec 2)
 * ============================================================ */

.transforms-inspector {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  min-height: 70vh;
}

.inspector-tabs {
  display: flex;
  gap: 0.25rem;
  border-bottom: 1px solid var(--panel-border, #2a3142);
}

.inspector-tab {
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-muted, #94a3b8);
  cursor: pointer;
  font: inherit;
  padding: 0.5rem 0.9rem;
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}

.inspector-tab.is-active {
  color: var(--text-strong, #e6edf7);
  border-bottom-color: var(--accent, #6b8afd);
}

.inspector-tab-soon {
  background: var(--panel-bg-2, #1f2937);
  color: var(--text-muted, #94a3b8);
  font-size: 0.7em;
  padding: 0.1em 0.4em;
  border-radius: 0.3em;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.inspector-body {
  flex: 1;
  min-height: 0;
}

.inspector-two-col {
  display: grid;
  grid-template-columns: minmax(260px, 1fr) 2fr;
  gap: 1rem;
  align-items: stretch;
  min-height: 60vh;
}

.inspector-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  min-height: 0;
}

.inspector-list-header {
  display: flex;
  gap: 0.5rem;
}

.inspector-search {
  flex: 1;
  background: var(--panel-bg-2, #1f2937);
  border: 1px solid var(--panel-border, #2a3142);
  color: inherit;
  padding: 0.35rem 0.5rem;
  border-radius: 0.4rem;
  font: inherit;
}

.inspector-add {
  background: var(--accent, #6b8afd);
  border: none;
  color: #fff;
  padding: 0.35rem 0.7rem;
  border-radius: 0.4rem;
  cursor: pointer;
  font: inherit;
}

.inspector-list-rows {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow: auto;
  max-height: 60vh;
  border: 1px solid var(--panel-border, #2a3142);
  border-radius: 0.4rem;
}

.inspector-list-rows li + li {
  border-top: 1px solid var(--panel-border, #2a3142);
}

.inspector-list-row {
  display: grid;
  grid-template-columns: 1fr;
  gap: 0.15rem;
  width: 100%;
  text-align: left;
  background: transparent;
  border: none;
  cursor: pointer;
  color: inherit;
  padding: 0.55rem 0.7rem;
  font: inherit;
}

.inspector-list-row:hover {
  background: var(--panel-hover, rgba(255, 255, 255, 0.04));
}

.inspector-list-row.is-selected {
  background: var(--panel-selected, rgba(107, 138, 253, 0.14));
}

.inspector-list-name {
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}

.inspector-list-key {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--text-muted, #94a3b8);
  font-size: 0.85em;
}

.inspector-list-desc {
  color: var(--text-muted, #94a3b8);
  font-size: 0.9em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.inspector-list-empty {
  color: var(--text-muted, #94a3b8);
  padding: 0.4rem;
}

.inspector-badge-user {
  background: var(--accent, #6b8afd);
  color: #fff;
  font-size: 0.65em;
  padding: 0.1em 0.4em;
  border-radius: 0.3em;
  text-transform: uppercase;
}

.inspector-transforms-row {
  grid-template-columns: 1.4fr 1fr auto auto 1fr 2fr;
  align-items: center;
}

.inspector-stage {
  font-size: 0.75em;
  padding: 0.1em 0.4em;
  border-radius: 0.3em;
  background: var(--panel-bg-2, #1f2937);
  color: var(--text-muted, #94a3b8);
}

.inspector-stage-1 { color: #6b8afd; }
.inspector-stage-2 { color: #4ec9a4; }

.inspector-views {
  font-size: 0.8em;
  color: var(--text-muted, #94a3b8);
}

.inspector-list-chips {
  display: inline-flex;
  gap: 0.25rem;
}

.inspector-chip-mini, .inspector-chip-overflow {
  background: var(--panel-bg-2, #1f2937);
  color: var(--text-muted, #94a3b8);
  font-size: 0.7em;
  padding: 0.1em 0.4em;
  border-radius: 0.3em;
}

.inspector-detail {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  border: 1px solid var(--panel-border, #2a3142);
  border-radius: 0.5rem;
  padding: 0.9rem;
  overflow: auto;
  max-height: 70vh;
}

.inspector-detail-empty {
  color: var(--text-muted, #94a3b8);
  display: grid;
  place-items: center;
  min-height: 200px;
}

.inspector-detail-header {
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
}

.inspector-detail-name {
  margin: 0;
  font-size: 1.1rem;
}

.inspector-detail-key {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--text-muted, #94a3b8);
  font-size: 0.9em;
}

.inspector-detail-meta {
  display: flex;
  gap: 0.6rem;
  align-items: center;
}

.inspector-detail-desc {
  margin: 0;
  color: var(--text-muted, #94a3b8);
}

.inspector-detail-section {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.inspector-detail-section h5 {
  margin: 0;
  font-size: 0.9rem;
  color: var(--text-muted, #94a3b8);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.inspector-sample {
  background: var(--panel-bg-2, #1f2937);
  border-radius: 0.4rem;
  padding: 0.6rem;
  font-size: 0.85em;
  overflow: auto;
  max-height: 240px;
  margin: 0;
}

.inspector-muted {
  color: var(--text-muted, #94a3b8);
  font-style: italic;
}

.inspector-chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.inspector-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  background: var(--panel-bg-2, #1f2937);
  color: inherit;
  border: 1px solid var(--panel-border, #2a3142);
  border-radius: 0.3em;
  padding: 0.15em 0.5em;
  font-size: 0.85em;
  cursor: pointer;
  font: inherit;
}

.inspector-chip:hover {
  border-color: var(--accent, #6b8afd);
}

.inspector-chip-key {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.inspector-chip-missing .inspector-chip-badge {
  color: #f88;
}

.inspector-source {
  display: grid;
  grid-template-columns: 180px 1fr;
  gap: 0.5rem;
  border: 1px solid var(--panel-border, #2a3142);
  border-radius: 0.4rem;
  background: var(--panel-bg-2, #1f2937);
  overflow: hidden;
}

.inspector-source-outline {
  border-right: 1px solid var(--panel-border, #2a3142);
  padding: 0.4rem;
  overflow: auto;
  max-height: 360px;
  font-size: 0.8em;
}

.inspector-source-outline ul {
  list-style: none;
  margin: 0;
  padding: 0;
}

.inspector-source-outline button {
  background: transparent;
  border: none;
  color: inherit;
  cursor: pointer;
  font: inherit;
  text-align: left;
  display: block;
  width: 100%;
  padding: 0.1rem 0.2rem;
}

.inspector-source-outline button:hover {
  background: var(--panel-hover, rgba(255, 255, 255, 0.04));
}

.inspector-outline-line {
  color: var(--text-muted, #94a3b8);
  margin-right: 0.4em;
}

.inspector-outline-branch button {
  padding-left: 1rem;
  color: var(--text-muted, #94a3b8);
}

.inspector-source-outline-empty {
  color: var(--text-muted, #94a3b8);
}

.inspector-source-code {
  margin: 0;
  padding: 0.5rem;
  overflow: auto;
  max-height: 360px;
  font-size: 0.85em;
}

.inspector-source-code .src-line {
  display: block;
}

.inspector-sheet {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.inspector-sheet-cancel {
  margin-left: auto;
  background: transparent;
  border: 1px solid var(--panel-border, #2a3142);
  color: inherit;
  padding: 0.25rem 0.6rem;
  border-radius: 0.3rem;
  cursor: pointer;
  font: inherit;
}

.inspector-sheet-tabs {
  display: flex;
  gap: 0.25rem;
}

.inspector-sheet-tabs button {
  background: transparent;
  border: 1px solid var(--panel-border, #2a3142);
  color: inherit;
  padding: 0.3rem 0.6rem;
  border-radius: 0.3rem;
  cursor: pointer;
  font: inherit;
}

.inspector-sheet-tabs button.is-active {
  border-color: var(--accent, #6b8afd);
  color: var(--accent, #6b8afd);
}

.inspector-event-picker,
.inspector-paste-area,
.inspector-field {
  width: 100%;
  background: var(--panel-bg, #0f172a);
  border: 1px solid var(--panel-border, #2a3142);
  color: inherit;
  padding: 0.35rem 0.5rem;
  border-radius: 0.3rem;
  font: inherit;
}

.inspector-paste-area {
  min-height: 100px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.85em;
}

.inspector-sheet-meta {
  display: grid;
  gap: 0.4rem;
}

.inspector-sheet-meta label {
  display: grid;
  grid-template-columns: 100px 1fr;
  align-items: center;
  gap: 0.4rem;
}

.inspector-match-info {
  margin: 0;
  font-size: 0.85em;
  color: var(--text-muted, #94a3b8);
}

.inspector-sheet-footer {
  display: flex;
  justify-content: flex-end;
  gap: 0.4rem;
}

.inspector-sheet-footer button {
  background: transparent;
  border: 1px solid var(--panel-border, #2a3142);
  color: inherit;
  padding: 0.35rem 0.8rem;
  border-radius: 0.3rem;
  cursor: pointer;
  font: inherit;
}

.inspector-primary {
  background: var(--accent, #6b8afd) !important;
  /* NOTE: avoid !important; rewrite as a more-specific selector below. */
}

.inspector-sheet-footer button.inspector-primary {
  background: var(--accent, #6b8afd);
  color: #fff;
  border-color: transparent;
}

.inspector-error {
  color: #f88;
  margin: 0;
  font-size: 0.85em;
}

.inspector-trace-placeholder {
  border: 1px dashed var(--panel-border, #2a3142);
  border-radius: 0.5rem;
  padding: 1.2rem;
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.inspector-trace-placeholder h4 {
  margin: 0;
}
```

**IMPORTANT during impl:** remove the placeholder `!important` rule
above — it's left in the plan as a demonstration of what NOT to ship.
The next rule (`.inspector-sheet-footer button.inspector-primary`) wins
by specificity. Drop the lone `.inspector-primary` block entirely.

- [ ] **Step 2: Commit**

```bash
git add client/src/app.css
git commit -m "$(cat <<'EOF'
client(inspector): inspector CSS (classes-only, no inline styles)

Lists/detail/source/sheet/tab strip styling. Uses CSS variables already
declared elsewhere in app.css so theme flips ride along.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 18: Final verification

- [ ] **Step 1: Typecheck**

```
cd client && npx tsc -b --noEmit
```

Expected: no errors.

- [ ] **Step 2: All unit + component tests**

```
cd client && npx vitest run
```

Expected: all pass.

- [ ] **Step 3: Vite build**

```
cd client && npx vite build
```

Expected: build succeeds. `?raw` imports inline at build time.

- [ ] **Step 4: Ladle build (sanity check that stories compile)**

```
cd client && npx ladle build
```

Expected: build succeeds. (If Ladle is not configured to build, run
`npx ladle serve --port 0 --no-open` for a quick lint pass.)

- [ ] **Step 5: Report**

Final report should include:

- Branch: `worktree-agent-a1ee2b88d7eb7cf64`
- Final commit hash
- A one-paragraph summary of what shipped, plus a note on the Trace
  placeholder + the mock-selector cutover point in `selectors/index.ts`.

---

## Self-review checklist (run before declaring done)

1. **Spec coverage**
   - Frozen seam types — Task 1
   - Mock selectors + barrel — Task 2
   - `BaseTransform.matches?: string[]` — Task 3
   - Selector store — Task 4
   - App-root provider — Task 5
   - `?raw` manifest + drift test — Task 6
   - Outline + tests — Task 7
   - Inference + tests — Task 8
   - Hash route — Task 9
   - Chips — Task 10
   - SourceView + story — Task 11
   - Types tab + story + tests — Task 12
   - TypeAuthoringSheet + story + tests — Task 13
   - Transforms tab + story + tests — Task 14
   - Inspector shell + story (incl. Trace placeholder) — Task 15
   - Modal-shell swap — Task 16
   - CSS — Task 17

2. **Placeholders**: none. The `!important` line in Task 17 is called
   out explicitly as a thing the executor must remove during impl.

3. **Type consistency**: `SelectorDef`, `StoredSelectorDef`, `Selector`,
   `InspectorTab`, `InspectorRoute`, `OutlineEntry` all match across
   their declaration + consumer tasks.
