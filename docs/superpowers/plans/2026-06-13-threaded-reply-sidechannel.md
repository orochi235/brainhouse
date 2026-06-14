# Threaded-Reply Side-Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give assistant turns triggered by a side channel (`/btw` interjections and background-task `<task-notification>` completions) an iMessage-style threaded-reply quote above the bubble, fix the bug where task-notifications borrow the `↩ btw` chip, and make the quote click-to-jump to the original entry in the panel/log lightbox (fetching it on demand if it's outside the live 1500-event window).

**Architecture:** The view pipeline's `tagBtwUserText` stage-1 transform classifies each `queued_command` attachment as either `btw` or `task`, stashing a `pendingReply` descriptor consumed by the next assistant bubble as a `replyTo` field. `/btw` still emits a plain user bubble; task-notifications emit a **compact anchor item** (not a raw bubble) that carries `data-anchor-uuid` so it remains a valid scroll target. `EventList` renders a dimmed quote `<button>` above any bubble with `replyTo`; clicking it opens the existing panel lightbox and scrolls/pulses the `refUuid` entry, backfilling that event via a new `eventByUuid` tRPC query when it's outside the client window.

**Tech Stack:** TypeScript, React 19, the brainhouse view-transform pipeline (`client/src/transforms/`), tRPC 11 (`server/src/trpc.ts`), vitest + @testing-library/react, happy-dom.

**Design decisions locked (this supersedes the spec where they differ):**
- Task-notifications are **rendered as a compact anchor item**, NOT fully suppressed — the lightbox uses the same `'conversation'` view, so a fully-suppressed notification would have no scroll target. The compact anchor keeps the raw `<task-notification>` text out of the flow while preserving a `data-anchor-uuid` to jump to.
- `replyTo.refUuid` for `btw` = the interjection event's uuid (the emitted user bubble). For `task` = the task-notification meta event's uuid (the compact anchor).
- Backfill reads the server's in-memory `panel.events[]` (capped at 10,000) by uuid — no JSONL re-scan, no caching.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `client/src/lib/pipeline-types.ts` | View-item types | Add `ReplyTo`, `NotificationAnchorItem`; add `replyTo` to `BubbleItem`; remove legacy `btw` |
| `client/src/transforms/types.ts` | Pipeline scratch contract | Replace `pendingBtwAssistant` with `pendingReply` |
| `client/src/transforms/runner.ts` | Scratch initialization | Init `pendingReply: null` |
| `client/src/transforms/builtIn/tagBtwUserText.ts` | Classify side-channel prompts | Split `queued_command` into `btw`/`task`; set `pendingReply`; emit compact anchor for `task` |
| `client/src/transforms/builtIn/assistantTextBubble.ts` | Emit assistant bubble | Consume `pendingReply` → `replyTo` |
| `client/src/components/CapsuleRow.tsx` | Row wrapper | Accept `anchorUuid` → `data-anchor-uuid` |
| `client/src/components/EventList.tsx` | Render view items | Quote button; `notification-anchor` render; `data-anchor-uuid`; `onReplyJump` prop |
| `client/src/app.css` | Styles | Generalize `.bubble.is-btw` → `.has-reply`; quote-line styles; task tint; compact-anchor; event-level focus-pulse |
| `server/src/session.ts` | In-memory panel events | Add `eventByUuid(panelId, uuid)` |
| `server/src/store.ts` | Store facade | Expose `eventByUuid` |
| `server/src/trpc.ts` | tRPC router | Add `eventByUuid` query |
| `client/src/components/ThreadedReplyLightbox.tsx` | §4 jump target | New: lightbox content that backfills + scrolls to `refUuid` |
| `client/src/components/PanelCard.tsx` | Owns panel + lightbox | Wire `onReplyJump` → open `ThreadedReplyLightbox` |
| `client/src/lib/pipeline.test.ts` | Pipeline tests | Un-skip + rewrite btw tests; add task tests |

---

## Task 1: Data model — `ReplyTo`, `NotificationAnchorItem`, scratch `pendingReply`

Additive types + scratch field. After this task the build is green; behavior is unchanged because nothing reads the new fields yet.

**Files:**
- Modify: `client/src/lib/pipeline-types.ts`
- Modify: `client/src/transforms/types.ts:19-40`
- Modify: `client/src/transforms/runner.ts:130-135`

- [ ] **Step 1: Add `ReplyTo` + `NotificationAnchorItem`, extend `BubbleItem` and `ViewItem`**

In `client/src/lib/pipeline-types.ts`, replace the `BubbleItem` interface's `btw` field and add the new types. Find:

```ts
export interface BubbleItem {
  type: 'bubble';
  event: Event;
  role: 'user' | 'assistant';
  parts: BubblePart[];
  canceled?: boolean;
  /** This assistant bubble responds to a `/btw` queued interjection. The
   * user bubble carrying the queued prompt itself renders normally; this
   * flag drives the "↩ btw" chip + accent on the reply so the response
   * (not the prompt) is what's marked. */
  btw?: boolean;
}
```

Replace with:

```ts
/** What an assistant turn is replying to when it was triggered by a side
 * channel rather than a normal top-line prompt. `btw` = a `/btw`
 * interjection; `task` = a background-task `<task-notification>`
 * completion. `quote` is the dimmed one-line preview shown above the
 * reply; `refUuid` is the original entry the quote jumps to. */
export interface ReplyTo {
  kind: 'btw' | 'task';
  quote: string;
  refUuid: string;
}

export interface BubbleItem {
  type: 'bubble';
  event: Event;
  role: 'user' | 'assistant';
  parts: BubblePart[];
  canceled?: boolean;
  /** Set when this assistant bubble was triggered by a side channel; drives
   * the threaded-reply quote line above the bubble body. Subsumes the old
   * `btw` boolean (`replyTo.kind === 'btw'`). */
  replyTo?: ReplyTo;
}

/** Compact, dimmed stand-in for a background-task `<task-notification>`
 * record. We don't render the raw notification markup as a user bubble, but
 * we keep this one-line anchor in the flow so the threaded-reply quote on
 * the following assistant turn has a real `data-anchor-uuid` to jump to. */
export interface NotificationAnchorItem {
  type: 'notification-anchor';
  anchorUuid: string;
  summary: string;
  ts: string;
}
```

Then add `NotificationAnchorItem` to the `ViewItem` union (after `OpStripItem`):

```ts
export type ViewItem =
  | BubbleItem
  | ToolItem
  | FileChangeItem
  | TerminalItem
  | OpStripItem
  | NotificationAnchorItem
  | { type: 'thinking'; event: Event; canceled?: boolean }
```

- [ ] **Step 2: Add `pendingReply` to the scratch contract**

In `client/src/transforms/types.ts`, add the import and replace the `pendingBtwAssistant` field. Change the import line at the top:

```ts
import type { ChecklistItem, ReplyTo, SubagentSpawn, ViewItem } from '../lib/pipeline-types.ts';
```

Replace:

```ts
  /** Set when a /btw prompt has just been emitted as a user bubble; the
   * next assistant_text bubble consumes it and renders with `btw:true`.
   * Cleared on a non-/btw user_text (a fresh prompt ends the chain). */
  pendingBtwAssistant: boolean;
```

with:

```ts
  /** Descriptor for the next assistant bubble to consume when the turn was
   * triggered by a side channel (`/btw` or a `<task-notification>`). The
   * assistant_text bubble copies it into `replyTo` and clears it. Cleared on
   * a non-/btw user_text (a fresh top-line prompt ends the chain). */
  pendingReply: ReplyTo | null;
```

- [ ] **Step 3: Initialize `pendingReply` in the runner**

In `client/src/transforms/runner.ts`, find the scratch init block (around line 130-135) and replace `pendingBtwAssistant: false,` with `pendingReply: null,`.

- [ ] **Step 4: Build to verify types compile (no behavior change)**

Run: `cd client && npx tsc -b 2>&1 | grep -iE "pipeline-types|transforms/(types|runner)|tagBtwUserText|assistantTextBubble"`
Expected: errors ONLY in `tagBtwUserText.ts` and `assistantTextBubble.ts` (they still reference `pendingBtwAssistant` / `btw`). These are fixed in Tasks 2–3. No errors in `pipeline-types.ts`, `types.ts`, or `runner.ts`.

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/pipeline-types.ts client/src/transforms/types.ts client/src/transforms/runner.ts
git commit -m "feat(transforms): add ReplyTo + notification-anchor types and pendingReply scratch"
```

---

## Task 2: Classification — split `queued_command` into `btw` vs `task`

Rewrite `tagBtwUserText` to classify the prompt, set `pendingReply`, and emit a compact anchor for task-notifications instead of a raw user bubble.

**Files:**
- Modify: `client/src/transforms/builtIn/tagBtwUserText.ts`
- Test: `client/src/lib/pipeline.test.ts` (un-skip + extend)

- [ ] **Step 1: Write the failing classification tests**

In `client/src/lib/pipeline.test.ts`, change `describe.skip(` at line ~762 to `describe(` and delete the stale comment above it (lines ~759-761 referencing "temporarily disabled in the registry" — `tagBtwUserText` is registered at `registry.ts:64`). Update the existing assertions that read `.btw` to read `.replyTo`. Concretely, in the test "queued user_text renders plain; the following assistant bubble is marked btw":

Replace `expect(btwUser.btw).toBeUndefined();` with `expect(btwUser.replyTo).toBeUndefined();` and `expect(btwAsst.btw).toBe(true);` with `expect(btwAsst.replyTo).toMatchObject({ kind: 'btw' });`. Apply the same `.btw → .replyTo` substitution to every assertion in the block (the `expect(a.btw).toBe(true)` lines become `expect(a.replyTo?.kind).toBe('btw')`, and `expect(b.btw).toBeUndefined()` become `expect(b.replyTo).toBeUndefined()`).

Then add a new test for task-notification classification at the end of the `describe` block:

```ts
it('task-notification queued_command emits a compact anchor (not a user bubble) and sets kind:task', () => {
  const notif =
    '<task-notification>\n' +
    '  <task-id>bi525uvu1</task-id>\n' +
    '  <status>completed</status>\n' +
    '  <summary>Background command "Search for Homebrew formula" completed (exit code 0)</summary>\n' +
    '</task-notification>';
  const { items } = preprocessEvents([
    ev('meta', {
      record_type: 'attachment',
      raw: { type: 'attachment', attachment: { type: 'queued_command', prompt: notif } },
    }),
    asstText('Found it — formula is `foo`.'),
  ]);
  // No user bubble for the raw notification; a compact anchor instead.
  const bubbles = items.filter((i) => i.type === 'bubble');
  expect(bubbles).toHaveLength(1); // only the assistant reply
  const anchor = items.find((i) => i.type === 'notification-anchor');
  expect(anchor).toMatchObject({
    type: 'notification-anchor',
    summary: 'Background command "Search for Homebrew formula" completed (exit code 0)',
  });
  const asst = bubbles[0];
  if (asst?.type !== 'bubble') throw new Error('expected assistant bubble');
  expect(asst.replyTo).toMatchObject({
    kind: 'task',
    quote: 'Background command "Search for Homebrew formula" completed (exit code 0)',
  });
  // refUuid points at the anchor entry so the quote can jump to it.
  if (anchor?.type !== 'notification-anchor') throw new Error('expected anchor');
  expect(asst.replyTo?.refUuid).toBe(anchor.anchorUuid);
});

it('a normal top-line user_text clears a pending task reply', () => {
  const notif = '<task-notification><summary>job done</summary></task-notification>';
  const { items } = preprocessEvents([
    ev('meta', {
      record_type: 'attachment',
      raw: { type: 'attachment', attachment: { type: 'queued_command', prompt: notif } },
    }),
    userText('a brand new prompt'),
    asstText('replying to the new prompt'),
  ]);
  const bubbles = items.filter((i) => i.type === 'bubble');
  const asst = bubbles[bubbles.length - 1];
  if (asst?.type !== 'bubble') throw new Error('expected assistant bubble');
  expect(asst.replyTo).toBeUndefined();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd client && npx vitest run src/lib/pipeline.test.ts -t "/btw queued prompt"`
Expected: FAIL — `tagBtwUserText` still sets `pendingBtwAssistant` and `btw`, and emits a user bubble for the task-notification.

- [ ] **Step 3: Rewrite `tagBtwUserText` classification + emission**

Replace the body of `run()` in `client/src/transforms/builtIn/tagBtwUserText.ts`. Add a summary-parsing helper above the transform:

```ts
/** Background-task notifications arrive as a `queued_command` prompt whose
 * trimmed text starts with `<task-notification`. Everything else on that
 * channel is a real `/btw` interjection. */
function isTaskNotification(trimmed: string): boolean {
  return trimmed.startsWith('<task-notification');
}

/** Pull the human-readable `<summary>` line out of a task-notification
 * payload. Falls back to a generic label if the markup lacks one. */
function parseSummary(prompt: string): string {
  const m = prompt.match(/<summary>([\s\S]*?)<\/summary>/);
  return (m?.[1] ?? 'background task completed').trim();
}
```

Then, inside `run()`, replace the `attType === 'queued_command'` branch (the block that pushes a user bubble and sets `pendingBtwAssistant = true`) with:

```ts
        if (attType === 'queued_command' && typeof prompt === 'string') {
          const trimmed = prompt.trim();
          // If a queue-operation enqueue already stashed this content, pop it
          // so a later user_text (if any arrives) doesn't double-render.
          const idx = ctx.scratch.pendingBtw.indexOf(trimmed);
          if (idx >= 0) ctx.scratch.pendingBtw.splice(idx, 1);

          if (isTaskNotification(trimmed)) {
            // Compact anchor instead of a raw `<task-notification>` bubble.
            const summary = parseSummary(prompt);
            items.push({
              type: 'notification-anchor',
              anchorUuid: event.uuid,
              summary,
              ts: event.ts,
            });
            ctx.scratch.pendingReply = { kind: 'task', quote: summary, refUuid: event.uuid };
            return true;
          }

          // Real /btw: emit the interjection as a plain user bubble.
          items.push({
            type: 'bubble',
            event: { ...event, kind: 'user_text', payload: { text: prompt } } as Event,
            role: 'user',
            parts: [{ kind: 'text', text: prompt }],
          });
          ctx.scratch.pendingReply = { kind: 'btw', quote: prompt, refUuid: event.uuid };
          return true;
        }
```

Update the deferred-delivery `user_text` branch at the bottom of `run()`. Replace:

```ts
    if (idx < 0) {
      // Non-/btw fresh prompt — clears any stale pending flag so a new
      // turn doesn't accidentally inherit the chip.
      ctx.scratch.pendingBtwAssistant = false;
      return false;
    }
    ctx.scratch.pendingBtw.splice(idx, 1);
    items.push({
      type: 'bubble',
      event,
      role: 'user',
      parts: [{ kind: 'text', text }],
    });
    ctx.scratch.pendingBtwAssistant = true;
    return true;
```

with:

```ts
    if (idx < 0) {
      // Non-/btw fresh top-line prompt — clears any stale pending reply so a
      // new turn doesn't inherit a quote.
      ctx.scratch.pendingReply = null;
      return false;
    }
    ctx.scratch.pendingBtw.splice(idx, 1);
    items.push({
      type: 'bubble',
      event,
      role: 'user',
      parts: [{ kind: 'text', text }],
    });
    ctx.scratch.pendingReply = { kind: 'btw', quote: text, refUuid: event.uuid };
    return true;
```

Update the transform's `description` string to mention the btw/task split. (Leave the file's top doc-comment's structure; add a sentence noting task-notifications become a compact anchor.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd client && npx vitest run src/lib/pipeline.test.ts -t "/btw queued prompt"`
Expected: PASS (all btw tests + the two new task tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/transforms/builtIn/tagBtwUserText.ts client/src/lib/pipeline.test.ts
git commit -m "feat(transforms): classify queued_command as btw vs task-notification"
```

---

## Task 3: Consume `pendingReply` into the assistant bubble

**Files:**
- Modify: `client/src/transforms/builtIn/assistantTextBubble.ts:39-57`
- Test: `client/src/lib/pipeline.test.ts`

- [ ] **Step 1: Write the failing consume test**

Add to the `describe('/btw queued prompt → marks next assistant bubble')` block in `client/src/lib/pipeline.test.ts`:

```ts
it('replyTo is consumed once and not inherited by a later turn', () => {
  const { items } = preprocessEvents([
    queueOp('also add oklch'),
    userText('also add oklch'),
    asstText('done — oklch added'),
    userText('now write tests'),
    asstText('tests written'),
  ]);
  const bubbles = items.filter((i) => i.type === 'bubble');
  const replyKinds = bubbles.map((b) => (b.type === 'bubble' ? b.replyTo?.kind : undefined));
  // user, assistant(btw reply), user(plain), assistant(plain)
  expect(replyKinds).toEqual([undefined, 'btw', undefined, undefined]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd client && npx vitest run src/lib/pipeline.test.ts -t "replyTo is consumed once"`
Expected: FAIL — `assistantTextBubble` still reads `pendingBtwAssistant` and writes `btw`, so `replyTo` is always undefined.

- [ ] **Step 3: Update `assistantTextBubble` to consume `pendingReply`**

In `client/src/transforms/builtIn/assistantTextBubble.ts`, replace:

```ts
    const btw = ctx.scratch.pendingBtwAssistant;
    ctx.scratch.pendingBtwAssistant = false;
    items.push({
      type: 'bubble',
      event,
      role: 'assistant',
      parts: [{ kind: 'text', text: event.payload.text ?? '' }],
      ...(btw ? { btw: true } : {}),
    });
    return true;
```

with:

```ts
    const replyTo = ctx.scratch.pendingReply;
    ctx.scratch.pendingReply = null;
    items.push({
      type: 'bubble',
      event,
      role: 'assistant',
      parts: [{ kind: 'text', text: event.payload.text ?? '' }],
      ...(replyTo ? { replyTo } : {}),
    });
    return true;
```

Note: the fold-onto-prior-capsule micro-ack branch (the `isFoldableAck` path above) returns early and does NOT consume `pendingReply` — a side-channel reply that is a bare "Done." would fold and leave `pendingReply` set for the next real bubble. This matches existing behavior (a folded ack was never marked btw either). Leave that branch unchanged.

- [ ] **Step 4: Run the full pipeline suite**

Run: `cd client && npx vitest run src/lib/pipeline.test.ts`
Expected: PASS (all preprocess + btw/task tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/transforms/builtIn/assistantTextBubble.ts client/src/lib/pipeline.test.ts
git commit -m "feat(transforms): consume pendingReply into bubble replyTo"
```

---

## Task 4: Render — quote button, compact anchor, `data-anchor-uuid`, styles

**Files:**
- Modify: `client/src/components/CapsuleRow.tsx`
- Modify: `client/src/components/EventList.tsx`
- Modify: `client/src/app.css`
- Test: `client/src/components/EventList.threadedReply.test.tsx` (new)

- [ ] **Step 1: Write the failing render test**

Create `client/src/components/EventList.threadedReply.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ViewItem } from '../lib/pipeline-types.ts';
import { LightboxProvider } from '../lib/lightbox.tsx';
import { ViewItemList } from './EventList.tsx';

function bubble(replyTo?: ViewItem extends infer _ ? never : never): never {
  throw new Error('unused');
}

const asstBubble = (replyTo: { kind: 'btw' | 'task'; quote: string; refUuid: string }) =>
  ({
    type: 'bubble' as const,
    role: 'assistant' as const,
    parts: [{ kind: 'text' as const, text: 'the reply body' }],
    replyTo,
    event: {
      kind: 'assistant_text',
      payload: { text: 'the reply body' },
      uuid: 'a1',
      parent_uuid: null,
      session_id: 's',
      agent_id: null,
      ts: '2026-06-13T00:00:00Z',
      cwd: null,
      tags: [],
    },
  }) as unknown as ViewItem;

describe('threaded-reply render', () => {
  it('renders a quote button with the quote text and the kind class', () => {
    const onReplyJump = vi.fn();
    render(
      <LightboxProvider>
        <ViewItemList
          items={[asstBubble({ kind: 'btw', quote: 'also add oklch', refUuid: 'x1' })]}
          onReplyJump={onReplyJump}
        />
      </LightboxProvider>,
    );
    const btn = screen.getByRole('button', { name: /also add oklch/ });
    expect(btn).toBeInTheDocument();
    btn.click();
    expect(onReplyJump).toHaveBeenCalledWith('x1');
  });

  it('marks the bubble row with kind-specific reply classes', () => {
    const { container } = render(
      <LightboxProvider>
        <ViewItemList
          items={[asstBubble({ kind: 'task', quote: 'job done', refUuid: 'x2' })]}
        />
      </LightboxProvider>,
    );
    expect(container.querySelector('.bubble.has-reply.is-task')).toBeTruthy();
    // No standalone "↩ btw" chip element anymore.
    expect(container.querySelector('.bubble.is-btw::before')).toBeNull();
  });

  it('renders a notification-anchor with a data-anchor-uuid scroll target', () => {
    const { container } = render(
      <LightboxProvider>
        <ViewItemList
          items={[
            {
              type: 'notification-anchor',
              anchorUuid: 'n1',
              summary: 'Background command "X" completed (exit code 0)',
              ts: '2026-06-13T00:00:00Z',
            } as ViewItem,
          ]}
        />
      </LightboxProvider>,
    );
    expect(container.querySelector('[data-anchor-uuid="n1"]')).toBeTruthy();
    expect(screen.getByText(/Background command "X" completed/)).toBeInTheDocument();
  });
});
```

(If `LightboxProvider` is not exported from `client/src/lib/lightbox.tsx`, render without it and drop the wrapper — the components under test don't call `useLightbox` directly; `onReplyJump` is the only interaction. Verify the export with `grep -n "export" client/src/lib/lightbox.tsx` and adjust.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd client && npx vitest run src/components/EventList.threadedReply.test.tsx`
Expected: FAIL — `ViewItemList` has no `onReplyJump`, renders no quote button, no `notification-anchor` branch, no `data-anchor-uuid`.

- [ ] **Step 3: Add `anchorUuid` support to `CapsuleRow`**

In `client/src/components/CapsuleRow.tsx`, add `anchorUuid?: string` to the `Props` interface and set it on the `<li>`. Change the props destructure to include `anchorUuid` and the element to:

```tsx
    <li
      className={classNames('event', `event-${kind}`, className)}
      onClick={onClick}
      data-anchor-uuid={anchorUuid}
    >
```

(When `anchorUuid` is `undefined`, React omits the attribute.)

- [ ] **Step 4: Thread `onReplyJump` and render the quote button + anchor in `EventList`**

In `client/src/components/EventList.tsx`:

a) Add `onReplyJump?: (refUuid: string) => void` to `EventListProps` and to `ViewItemList`'s props, and pass it down to `Item`.

b) In the `Bubble` component, add `onReplyJump` to its props, set `data-anchor-uuid`, render the quote button above the body, and switch the class from `is-btw` to the generalized reply classes:

```tsx
function Bubble({
  item,
  startedAt,
  onBubbleClick,
  onReplyJump,
}: {
  item: Extract<ViewItem, { type: 'bubble' }>;
  startedAt?: number;
  onBubbleClick?: (event: Event) => void;
  onReplyJump?: (refUuid: string) => void;
}) {
  const reply = item.replyTo;
  return (
    <CapsuleRow
      kind={`${item.role}_text`}
      ts={item.event.ts}
      startedAt={startedAt}
      anchorUuid={item.event.uuid}
      className={classNames(
        item.canceled && 'canceled',
        reply && 'has-reply',
        reply?.kind === 'btw' && 'is-btw',
        reply?.kind === 'task' && 'is-task',
      )}
      onClick={() => onBubbleClick?.(item.event)}
    >
      {reply && (
        <button
          type="button"
          className="reply-quote"
          title="Jump to the original"
          onClick={(e) => {
            e.stopPropagation();
            onReplyJump?.(reply.refUuid);
          }}
        >
          ↩ {reply.quote}
        </button>
      )}
      <div
        className={classNames(
          'bubble',
          reply && 'has-reply',
          reply?.kind === 'btw' && 'is-btw',
          reply?.kind === 'task' && 'is-task',
        )}
      >
        {item.parts.map((part, i) => (
          <BubblePartView key={`${item.event.uuid}-${i}`} part={part} escape={item.role === 'user'} />
        ))}
      </div>
    </CapsuleRow>
  );
}
```

c) Add a `NotificationAnchor` renderer and wire it into the `Item` switch. Add the component:

```tsx
function NotificationAnchor({
  item,
  startedAt,
}: {
  item: Extract<ViewItem, { type: 'notification-anchor' }>;
  startedAt?: number;
}) {
  return (
    <CapsuleRow kind="notification-anchor" ts={item.ts} startedAt={startedAt} anchorUuid={item.anchorUuid}>
      <div className="notification-anchor">⇣ {item.summary}</div>
    </CapsuleRow>
  );
}
```

In the `itemKey` function add: `if (item.type === 'notification-anchor') return \`notif:${item.anchorUuid}\`;`

In the `Item` dispatch (the switch/if-chain that renders each `ViewItem`), add a branch:

```tsx
  if (item.type === 'notification-anchor') {
    return <NotificationAnchor item={item} startedAt={startedAt} />;
  }
```

and make sure `Item` forwards `onReplyJump` to `Bubble`.

- [ ] **Step 5: Add styles in `app.css`**

In `client/src/app.css`, replace the `.bubble.is-btw` block (the `/* /btw — assistant response ... */` section, including the `::before` chip) with the generalized treatment:

```css
/* Threaded-reply treatment — an assistant turn triggered by a side channel
   (a /btw interjection or a background-task notification) carries a dimmed
   quote of what it's replying to, plus a single-side accent whose color
   encodes the kind. Replaces the old standalone "↩ btw" chip. */
.bubble.has-reply {
  border-left: 2px solid color-mix(in srgb, var(--bubble-assistant-fg) 35%, transparent);
  padding-left: 0.55rem;
}
.bubble.is-task {
  /* Cool/info tint distinguishes background-task replies from /btw. */
  border-left-color: color-mix(in srgb, var(--accent) 45%, transparent);
}
.reply-quote {
  display: block;
  max-width: 100%;
  margin: 0 0 0.2rem;
  padding: 0;
  border: none;
  background: none;
  font: inherit;
  font-size: 0.72rem;
  text-align: left;
  color: color-mix(in srgb, currentColor 55%, transparent);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
}
.reply-quote:hover {
  color: color-mix(in srgb, currentColor 80%, transparent);
  text-decoration: underline;
}
/* Compact stand-in for a raw <task-notification> record. */
.notification-anchor {
  font-size: 0.72rem;
  opacity: 0.6;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* Event-level focus pulse — reuses the panel pulse motif so a jumped-to
   entry flashes briefly. */
.event.focus-pulse {
  animation: event-focus-pulse 0.9s ease-out;
  border-radius: 6px;
}
@keyframes event-focus-pulse {
  0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 55%, transparent); }
  100% { box-shadow: 0 0 0 14px color-mix(in srgb, var(--accent) 0%, transparent); }
}
```

- [ ] **Step 6: Run the render test + full client suite for regressions**

Run: `cd client && npx vitest run src/components/EventList.threadedReply.test.tsx`
Expected: PASS.
Run: `cd client && npx vitest run src/lib/pipeline.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add client/src/components/CapsuleRow.tsx client/src/components/EventList.tsx client/src/app.css client/src/components/EventList.threadedReply.test.tsx
git commit -m "feat(client): render threaded-reply quote button + compact notification anchor"
```

---

## Task 5: Remove the legacy `btw` boolean and `pendingBtwAssistant`

Now that everything reads `replyTo` / `pendingReply`, delete the dead fields so the model has one source of truth.

**Files:**
- Modify: `client/src/lib/pipeline-types.ts` (already removed `btw` in Task 1 — verify no stragglers)
- Search the tree for stragglers.

- [ ] **Step 1: Find any remaining references**

Run: `cd client && grep -rn "pendingBtwAssistant\|\.btw\b\|is-btw" src | grep -v node_modules`
Expected: only the intentional `.bubble.is-btw` CSS (kept as the neutral-kind accent) and `reply?.kind === 'btw' && 'is-btw'` in `EventList.tsx`. No references to `pendingBtwAssistant` or `item.btw` should remain. Fix any that do.

- [ ] **Step 2: Typecheck**

Run: `cd client && npx tsc -b 2>&1 | grep -iE "btw|pendingReply|replyTo"`
Expected: empty (no errors related to the migration).

- [ ] **Step 3: Commit (only if changes were needed)**

```bash
git add -A client/src
git commit -m "refactor(transforms): drop legacy btw flag in favor of replyTo"
```

---

## Task 6: §4 server — `eventByUuid` tRPC query

Expose a single panel event by uuid from the server's in-memory `panel.events[]` (capped at 10,000 — larger than the client's 1500 window), so the client can backfill a jump target outside its window.

**Files:**
- Modify: `server/src/session.ts`
- Modify: `server/src/store.ts`
- Modify: `server/src/trpc.ts`
- Test: `server/src/session.test.ts` (add) and/or `server/src/trpc.test.ts` if present

- [ ] **Step 1: Write the failing session test**

Add to the session store test file (find it: `ls server/src/session*.test.ts`; if none, create `server/src/session.eventByUuid.test.ts`). Use the existing test's panel/event construction helpers (read the top of the existing session test for the pattern). The test:

```ts
import { describe, expect, it } from 'vitest';
// import { SessionStore } from './session.ts';  // adjust to actual export

describe('eventByUuid', () => {
  it('returns the in-memory event for a panel by uuid, or null when absent', () => {
    // Arrange: build a SessionStore with one panel holding events u1..u3.
    // (Follow the construction pattern already used in this file.)
    const store = /* build a SessionStore with a panel 'p1' whose events
       include one with uuid 'u2' */ null as any;
    expect(store.eventByUuid('p1', 'u2')?.uuid).toBe('u2');
    expect(store.eventByUuid('p1', 'nope')).toBeNull();
    expect(store.eventByUuid('missing-panel', 'u2')).toBeNull();
  });
});
```

(The executor must fill the SessionStore construction by mirroring the existing test setup in that file — do not invent a new constructor. If the existing tests drive the store via `monitor`/JSONL fixtures, follow that route instead and assert via the same path.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run src/session.eventByUuid.test.ts`
Expected: FAIL — `eventByUuid` is not a method.

- [ ] **Step 3: Add `eventByUuid` to the session store**

In `server/src/session.ts`, add a method on the class that owns the `private readonly panels = new Map<string, Panel>()` field:

```ts
  /** Look up a single event by uuid within a panel's in-memory window
   * (capped at MAX_EVENTS_PER_PANEL = 10_000, larger than the client's live
   * window). Returns null if the panel or event isn't resident. No JSONL
   * re-scan — callers accept that events evicted past the server cap are
   * unavailable. */
  eventByUuid(panelId: string, uuid: string): Event | null {
    const panel = this.panels.get(panelId);
    if (!panel) return null;
    return panel.events.find((e) => e.uuid === uuid) ?? null;
  }
```

Ensure `Event` is imported in `session.ts` (it already uses `Event[]` for `panel.events`).

- [ ] **Step 4: Expose it on the store facade**

In `server/src/store.ts`, add a passthrough on the `Store` class (the type referenced as `ctx.monitor.store`). If `Store` delegates to the session store, add:

```ts
  eventByUuid(panelId: string, uuid: string): Event | null {
    return this.sessions.eventByUuid(panelId, uuid);
  }
```

(Match the actual field name the store uses for its session store — verify with `grep -n "eventsForPanel\|snapshot()" server/src/store.ts` and mirror how an existing method delegates. If `eventsForPanel` lives directly on `Store`, add `eventByUuid` right beside it using the same data source the in-memory snapshot uses.)

- [ ] **Step 5: Add the tRPC query**

In `server/src/trpc.ts`, add inside the `appRouter` object:

```ts
  eventByUuid: t.procedure
    .input(z.object({ panelId: z.string(), uuid: z.string() }))
    .query(({ ctx, input }) => ({
      event: ctx.monitor.store.eventByUuid(input.panelId, input.uuid),
    })),
```

- [ ] **Step 6: Run server tests + typecheck**

Run: `cd server && npx vitest run src/session.eventByUuid.test.ts`
Expected: PASS.
Run: `cd server && npx tsc -b 2>&1 | grep -iE "eventByUuid|trpc|session|store"`
Expected: empty.

- [ ] **Step 7: Commit**

```bash
git add server/src/session.ts server/src/store.ts server/src/trpc.ts server/src/session.eventByUuid.test.ts
git commit -m "feat(server): eventByUuid tRPC query for threaded-reply backfill"
```

---

## Task 7: §4 client — `ThreadedReplyLightbox` + wire the quote click

Open the panel lightbox on quote click, scroll/pulse the `refUuid` entry, and backfill the event from the server when it's outside the client's live window.

**Files:**
- Create: `client/src/components/ThreadedReplyLightbox.tsx`
- Modify: `client/src/components/PanelCard.tsx`
- Test: `client/src/components/ThreadedReplyLightbox.test.tsx` (new)

- [ ] **Step 1: Write the failing component test**

Create `client/src/components/ThreadedReplyLightbox.test.tsx`. Mock the tRPC client and assert the backfill path. The test renders the component with a panel missing the target uuid and verifies it calls `trpc.eventByUuid.query` and then renders the fetched event:

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../trpc.ts', () => ({
  trpc: {
    eventByUuid: {
      query: vi.fn(async () => ({
        event: {
          kind: 'assistant_text',
          payload: { text: 'the backfilled original' },
          uuid: 'far-uuid',
          parent_uuid: null,
          session_id: 's',
          agent_id: null,
          ts: '2026-06-12T00:00:00Z',
          cwd: null,
          tags: [],
        },
      })),
    },
  },
}));

import { trpc } from '../trpc.ts';
import { ThreadedReplyLightbox } from './ThreadedReplyLightbox.tsx';

const panel = {
  id: 'p1',
  title: 'Test panel',
  cwd: null,
  theme: null,
  manually_renamed: false,
  events: [
    {
      kind: 'assistant_text',
      payload: { text: 'in-window event' },
      uuid: 'near-uuid',
      parent_uuid: null,
      session_id: 's',
      agent_id: null,
      ts: '2026-06-13T00:00:00Z',
      cwd: null,
      tags: [],
    },
  ],
} as unknown as Parameters<typeof ThreadedReplyLightbox>[0]['panel'];

describe('ThreadedReplyLightbox', () => {
  it('backfills an out-of-window refUuid and renders it', async () => {
    render(<ThreadedReplyLightbox panel={panel} refUuid="far-uuid" />);
    await waitFor(() => expect(trpc.eventByUuid.query).toHaveBeenCalledWith({ panelId: 'p1', uuid: 'far-uuid' }));
    await waitFor(() => expect(screen.getByText(/the backfilled original/)).toBeInTheDocument());
  });

  it('does not backfill when refUuid is already in the window', async () => {
    render(<ThreadedReplyLightbox panel={panel} refUuid="near-uuid" />);
    expect(screen.getByText(/in-window event/)).toBeInTheDocument();
    expect(trpc.eventByUuid.query).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd client && npx vitest run src/components/ThreadedReplyLightbox.test.tsx`
Expected: FAIL — module `./ThreadedReplyLightbox.tsx` does not exist.

- [ ] **Step 3: Implement `ThreadedReplyLightbox`**

Create `client/src/components/ThreadedReplyLightbox.tsx`:

```tsx
import type { Event } from '@server/parser.ts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { renderInlineCode } from '../lib/inlineCode.tsx'; // adjust import to the helper PanelLightboxContent uses for titles
import type { PanelState } from '../lib/panelTypes.ts'; // adjust to the actual PanelState type location
import { trpc } from '../trpc.ts';
import { EventList } from './EventList.tsx';

/** Lightbox content for a threaded-reply jump. Renders the panel's events
 * (backfilling the target on demand when it's outside the live window) and
 * scrolls + pulses the target once it's present. */
export function ThreadedReplyLightbox({ panel, refUuid }: { panel: PanelState; refUuid: string }) {
  const [extra, setExtra] = useState<Event | null>(null);

  const inWindow = useMemo(
    () => panel.events.some((e) => e.uuid === refUuid),
    [panel.events, refUuid],
  );

  // Backfill from the server when the target isn't resident client-side.
  useEffect(() => {
    if (inWindow) return;
    let alive = true;
    trpc.eventByUuid.query({ panelId: panel.id, uuid: refUuid }).then((res) => {
      if (alive && res.event) setExtra(res.event as Event);
    });
    return () => {
      alive = false;
    };
  }, [inWindow, panel.id, refUuid]);

  // Merge any backfilled event into the stream in ts order.
  const events = useMemo<Event[]>(() => {
    if (inWindow || !extra) return panel.events;
    const merged = [...panel.events, extra];
    merged.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    return merged;
  }, [inWindow, extra, panel.events]);

  // Scroll + pulse the target once it's in the DOM.
  const scrolled = useRef(false);
  useEffect(() => {
    if (scrolled.current) return;
    const present = events.some((e) => e.uuid === refUuid);
    if (!present) return;
    const raf = requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-anchor-uuid="${CSS.escape(refUuid)}"]`);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('focus-pulse');
      window.setTimeout(() => el.classList.remove('focus-pulse'), 900);
      scrolled.current = true;
    });
    return () => cancelAnimationFrame(raf);
  }, [events, refUuid]);

  return (
    <>
      <h3 className="lightbox-title">{renderInlineCode(panel.title)}</h3>
      <EventList events={events} cwd={panel.cwd} />
    </>
  );
}
```

(Before coding, confirm the real imports: open `client/src/components/PanelCard.tsx` `PanelLightboxContent` (~line 1248) and copy its exact `renderInlineCode`/title helper and the `PanelState` type import path. Reuse those rather than the placeholders above. The scroll/pulse block mirrors `focusPanel` at `PanelCard.tsx:1225-1231`, swapping `data-panel-id` for `data-anchor-uuid` and `.panel` for `.event` pulse.)

- [ ] **Step 4: Run the component test**

Run: `cd client && npx vitest run src/components/ThreadedReplyLightbox.test.tsx`
Expected: PASS.

- [ ] **Step 5: Wire `onReplyJump` in `PanelCard`**

In `client/src/components/PanelCard.tsx`, find where the panel body renders `<EventList ... />` (the in-card conversation render) and add the `onReplyJump` prop. It needs `lightbox` (from `useLightbox()`, already in scope where `⛶` opens `PanelLightboxContent`) and `panel`:

```tsx
        <EventList
          events={panel.events}
          cwd={panel.cwd}
          onReplyJump={(refUuid) =>
            lightbox.open(<ThreadedReplyLightbox panel={panel} refUuid={refUuid} />, {
              theme: panel.theme,
            })
          }
        />
```

Add `import { ThreadedReplyLightbox } from './ThreadedReplyLightbox.tsx';` at the top. (Verify `lightbox` is in scope in this component — it's used by the `⛶` ToolChip at ~line 806; if the EventList render is in a different sub-component, pass `onReplyJump` down or obtain `useLightbox()` there.)

- [ ] **Step 6: Manual/browser verification**

Build the client bundle (note: the branch has pre-existing unrelated `tsc` errors — scope the check to the touched files):
Run: `cd client && npx tsc -b 2>&1 | grep -iE "ThreadedReply|PanelCard|EventList|CapsuleRow"`
Expected: empty.

Then run the app and confirm: a background-task reply shows the cool-tinted quote (not a `↩ btw` chip), a `/btw` reply shows the neutral quote, and clicking either opens the lightbox scrolled+pulsed to the original (test one in-window and, if reachable, one beyond 1500 events to exercise backfill). Use the project's run path (`npm run dev`, then drive the page); check the console for zero errors.

- [ ] **Step 7: Commit**

```bash
git add client/src/components/ThreadedReplyLightbox.tsx client/src/components/ThreadedReplyLightbox.test.tsx client/src/components/PanelCard.tsx
git commit -m "feat(client): click threaded-reply quote → lightbox scroll + on-demand backfill"
```

---

## Task 8: Docs + assertions

**Files:**
- Modify: `docs/assertions.md`
- Modify: `docs/superpowers/specs/2026-06-13-threaded-reply-sidechannel-design.md` (status note)

- [ ] **Step 1: Append behavior rules to `docs/assertions.md`**

Add rules capturing: (a) task-notification `queued_command` records render as a compact anchor and never as a raw user bubble; (b) an assistant turn triggered by a side channel shows a dimmed quote whose accent color encodes kind (`btw` neutral, `task` cool); (c) clicking the quote opens the panel lightbox and scrolls/pulses the original, backfilling it when outside the live window.

- [ ] **Step 2: Mark the spec implemented**

In the spec's header, change `Status: design approved, ready for implementation plan` to `Status: implemented (plan 2026-06-13-threaded-reply-sidechannel.md)`. Note inline that the "suppress task-notification bubble" decision was revised to "compact anchor" so the lightbox has a scroll target.

- [ ] **Step 3: Final full test sweep**

Run: `cd client && npx vitest run src/lib/pipeline.test.ts src/components/EventList.threadedReply.test.tsx src/components/ThreadedReplyLightbox.test.tsx`
Run: `cd server && npx vitest run src/session.eventByUuid.test.ts`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add docs/assertions.md docs/superpowers/specs/2026-06-13-threaded-reply-sidechannel-design.md
git commit -m "docs: threaded-reply assertions + spec status"
```

---

## Self-Review Notes

- **Spec coverage:** §1 classification → Task 2; `pendingReply` scratch → Task 1; §2 consume → Task 3; §3 render (quote button, kind color, replaces chip, `data-anchor-uuid`) → Task 4; §4 scroll/pulse + backfill (+ server endpoint) → Tasks 6–7; testing (un-skip + new) → Tasks 2–7. The spec's "suppress" decision is deliberately revised to "compact anchor" (documented in the header and Task 8) per the resolved suppress-vs-jump-target tension.
- **Out of scope (per spec):** jumping to the launching `tool-use-id`; distinct rendering of the `<result>` report body; backfill for events evicted past the server's 10,000 cap (returns null → no scroll, no crash).
- **Type consistency:** `ReplyTo { kind, quote, refUuid }` is the single shape used by scratch `pendingReply`, `BubbleItem.replyTo`, and the `onReplyJump` payload (`refUuid`). `NotificationAnchorItem { type:'notification-anchor', anchorUuid, summary, ts }` is consistent across the transform, `itemKey`, and the renderer. `eventByUuid(panelId, uuid)` is identical across session/store/tRPC.
