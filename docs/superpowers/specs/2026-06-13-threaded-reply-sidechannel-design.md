# Threaded-reply treatment for side-channel-triggered assistant turns

Date: 2026-06-13
Status: implemented (see docs/superpowers/plans/2026-06-13-threaded-reply-sidechannel.md)

## Problem

Two things are wrong/missing around assistant turns that are driven by a
*side channel* rather than a normal top-line user prompt:

1. **Bug — the `↩ btw` chip is mislabeled.** `tagBtwUserText.ts` flags the
   next assistant bubble as `btw` for *any* `queued_command` attachment. But
   Claude Code reuses `queued_command` for two unrelated things: real `/btw`
   interjections **and** background-task `<task-notification>` completions. In
   real transcripts the notifications dominate (≈239 vs the `/btw` prompts),
   so in practice the chip almost always lands on replies to background-task
   completions, not `/btw` — which is what the user actually sees.

2. **Feature — make these turns self-explanatory.** Borrow iMessage's
   threaded-reply convention: an assistant turn triggered by a side channel
   shows a small, dimmed quote of *what it is replying to* directly above the
   bubble body, and clicking that quote jumps to the original in the log.

## Background: the two side-channel shapes (from real JSONL)

Both arrive as a `meta` record, `record_type: 'attachment'`, with
`raw.attachment.type === 'queued_command'` and an `attachment.prompt`.

- **Real `/btw`** — `prompt` is natural-language user text (e.g.
  `"also add oklch to models"`). (Older/deferred flow: a `queue-operation`
  enqueue stashes the text, and it later arrives as a normal `user_text`.)
- **Task-notification** — `prompt` is structured markup:

  ```
  <task-notification>
    <task-id>bi525uvu1</task-id>
    <tool-use-id>toolu_01Sdib…</tool-use-id>
    <output-file>/private/tmp/…/bi525uvu1.output</output-file>
    <status>completed</status>
    <summary>Background command "Search for Homebrew formula" completed (exit code 0)</summary>
    <result>## Report …</result>   ← present for background agents
  </task-notification>
  ```

  Three flavors: background Bash (`Background command "…" completed (exit N)`),
  background agent/subagent (`Agent "…" completed` + `<result>`), and Monitor
  events (`<summary>Monitor event: …</summary>`). It is the async-completion
  callback for a job the agent previously launched. `<task-notification>` is
  already a recognized text marker (`inference.ts:10`).

## Design

### 1. Classification (`tagBtwUserText.ts`)

Split the `queued_command` branch by inspecting the trimmed prompt:

- Prompt starts with `<task-notification` → **task-notification**.
- Otherwise → **real `/btw`** (today's behavior).

(Optionally generalize the marker test against the known marker tags in
`inference.ts:10`, but only `task-notification` is observed via
`queued_command`.)

Instead of a boolean `pendingBtwAssistant`, stash a small descriptor for the
*next* assistant bubble to consume:

```ts
ctx.scratch.pendingReply = {
  kind: 'btw' | 'task',
  quote: string,      // btw: the interjection text; task: the <summary> line
  refUuid: string,    // the original event to jump to (see §4)
}
```

Per-kind handling:

- **`/btw`**: emit the interjection as a plain user bubble (today's behavior),
  set `pendingReply = { kind:'btw', quote: text, refUuid: <interjection event uuid> }`.
- **task-notification**: **suppress** the raw `<task-notification>` bubble in
  the conversation view (do not emit a user bubble); parse out `<summary>`
  for `quote`; set `pendingReply = { kind:'task', quote: summary,
  refUuid: <the task-notification event uuid> }`.

A normal `user_text` (non-`/btw`) clears `pendingReply` so a fresh turn never
inherits a quote. Raw `queue-operation` bookkeeping records stay consumed.

Update `types.ts` scratch to carry `pendingReply` (replacing the
`pendingBtw*` pair, or alongside during migration).

### 2. Consume into the assistant bubble (`assistantTextBubble.ts`)

Where it currently reads `pendingBtwAssistant`, read `pendingReply` and set a
`replyTo` field on the assistant bubble item, then clear it:

```ts
replyTo?: { kind: 'btw' | 'task'; quote: string; refUuid: string }
```

Add `replyTo` to the bubble `ViewItem` type (the type behind `item.btw` today;
`pipeline-types.ts` / `pipeline.ts`). The legacy `btw` boolean is subsumed by
`replyTo.kind === 'btw'`.

### 3. Render (`EventList.tsx` + `app.css`)

When a bubble has `replyTo`, render above its body a small, dimmed,
single-line **quote button**:

```
  ↩ also add oklch to models                     ← replyTo.quote (truncated, button)
 ┃ Done — oklch now sits alongside hex and rgb.   ← bubble body, left-border accent
```

- Keep the existing single-side-border motif (today's `.bubble.is-btw`),
  generalized to `.bubble.has-reply` (or `.bubble.is-btw` / `.bubble.is-task`).
- **Border color encodes kind**: `btw` = neutral (current
  `--bubble-assistant-fg` tint); `task` = a distinct cool/info tint.
- The standalone `↩ btw` `::before` chip is **replaced** by the quote line
  (self-describing). Quote text truncates to one line with ellipsis.
- The quote is a `<button>` (keyboard-focusable) for the click behavior in §4.

### 4. Click → open log lightbox, scroll to original

Clicking the quote opens the **existing panel/log lightbox**
(`PanelLightboxContent`, same one the panel header/`⛶` opens) and scrolls to +
pulses the `refUuid` entry.

- Scroll/pulse: reuse the established pattern — `scrollIntoView({ block:
  'center' })` + add/remove `focus-pulse` (see `PanelCard.tsx:1228-1230`,
  `useAwaitingNotifications.ts:113`).
- **DOM anchor gap**: rendered items currently expose a React key
  (`EventList.tsx:84-89` `tool:${anchorUuid}` etc.) but not necessarily a
  stable DOM attribute to query. Implementation must add a
  `data-anchor-uuid` (or similar) on rendered bubbles/items so the lightbox
  can locate the target.
- **On-demand fetch (lag OK, ~1-2s)**: the live event window is capped at
  1500 (`feat/event-window-lazy-backfill`), so `refUuid` may not be loaded.
  If the target isn't present in the lightbox's events, fetch it on demand
  (extend the lazy-backfill path; may need a server endpoint to fetch a
  turn/event by uuid) before scrolling. No caching required.

## Decisions locked

- Treatment attaches to the **assistant reply** (not the trigger bubble),
  mirroring `/btw`.
- Task-notification raw bubble is **suppressed** in the conversation view;
  its `<summary>` survives as the reply's quote. *(Implementation note:
  "suppress" was revised to "render a compact anchor item" — the lightbox
  uses the same conversation view, so a fully-suppressed notification would
  have no scroll target for the quote click.)*
- Task-notification click target = **the notification entry itself**
  (full summary/result), not the launching tool-use.
- Jump destination = the **existing panel/log lightbox**, not the `⌁`
  timeline lightbox.
- Quote content for task = the `<summary>` line, truncated to one line.

## Out of scope / future

- A second click affordance to jump to the *launching* `tool-use-id` (where
  the background job started) — the notification carries it; nice later.
- Distinct rendering of the `<result>` report body.

## Testing

- Re-enable the currently `describe.skip`'d `/btw` tests in
  `pipeline.test.ts:759` (the "temporarily disabled" note is stale — the
  transform is live in `registry.ts:64`).
- Classification: a `<task-notification>` `queued_command` does **not** set
  `kind:'btw'` and does **not** emit a raw user bubble; it sets
  `kind:'task'` with the parsed `<summary>` as quote.
- `/btw` still emits its user bubble and sets `kind:'btw'`.
- `replyTo` lands on the following assistant bubble and is cleared by a
  subsequent normal `user_text`.
- Render: a bubble with `replyTo` shows the quote button + correct
  kind class; no standalone `↩ btw` chip.
- (Integration, lighter) click handler resolves `refUuid` → opens lightbox →
  scrolls; backfill path when the uuid is outside the window.

## File touchpoints

- `client/src/transforms/builtIn/tagBtwUserText.ts` — classification + `pendingReply`.
- `client/src/transforms/builtIn/assistantTextBubble.ts` — consume → `replyTo`.
- `client/src/transforms/types.ts` — scratch `pendingReply`.
- `client/src/lib/pipeline-types.ts` (or `pipeline.ts`) — `replyTo` on bubble item.
- `client/src/components/EventList.tsx` — quote button render + `data-anchor-uuid` + click.
- `client/src/app.css` — generalize `.bubble.is-btw` motif + quote-line styles + task tint.
- `client/src/lib/lightbox*` + lightbox open path — scroll-to-uuid + on-demand backfill.
- `client/src/lib/pipeline.test.ts` — un-skip + new tests.
