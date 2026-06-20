/**
 * Detects `/btw` interjections and task-notification completions from the
 * side-channel queue, classifying them as `btw` or `task` and setting
 * `pendingReply` so the next assistant bubble can render a threaded-reply
 * quote line.
 *
 * Two side-channel shapes in the JSONL are handled here:
 *
 * 1. **Inline delivery (Claude Code ≥ 2.1.13x).** The agent is mid-turn,
 *    the queued prompt is delivered as an `attachment` record with
 *    `attachment.type === 'queued_command'` and `attachment.prompt`. There
 *    is **no** follow-up `type:user` record carrying the same text.
 *
 *    - If the prompt starts with `<task-notification`, it is a background
 *      task completion. We emit a compact `notification-anchor` item
 *      (instead of a raw `<task-notification>` user bubble) and set
 *      `pendingReply` to `{ kind: 'task', … }`.
 *    - Otherwise it is a real `/btw` interjection. We emit a plain user
 *      bubble and set `pendingReply` to `{ kind: 'btw', … }`.
 *
 * 2. **Deferred delivery (older flow).** The agent was idle, so the
 *    queued prompt eventually arrives as a normal `type:user` record with
 *    its own uuid. We stash any enqueued content from `queue-operation`
 *    in `ctx.scratch.pendingBtw` and, on the matching user_text, emit a
 *    plain user bubble and set `pendingReply` to `{ kind: 'btw', … }`.
 *    Non-/btw user_texts fall through to `userTextBubble`.
 *
 * In both flows, `queue-operation` records (enqueue/dequeue/popAll/remove)
 * are consumed and never rendered — they're queue bookkeeping. Other
 * `attachment` shapes (hook_success, hook_additional_context, …) fall
 * through to `defaultEventItem`, which absorbs them.
 */

import type { Event } from '@server/parser.ts';
import type { Stage1Transform } from '../types.ts';

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

export const tagBtwUserText: Stage1Transform = {
  kind: 'view',
  stage: 1,
  key: 'built-in.tag-btw-user-text',
  name: '/btw + task-notification queued prompt → reply quote on next assistant bubble',
  description:
    'Detects queued /btw prompts and background task-notifications from the side channel. /btw interjections (queued_command attachment payloads or queue-operation/user_text pairs) emit a plain user bubble and set pendingReply { kind: "btw" }. Task-notification payloads emit a compact notification-anchor item (not a user bubble) and set pendingReply { kind: "task" }. The next assistant bubble consumes pendingReply into replyTo. Consumes noisy queue-operation bookkeeping records.',
  matches: ['meta.any', 'user-text.any'],
  run(event, items, ctx) {
    if (event.kind === 'meta') {
      if (event.payload.record_type === 'queue-operation') {
        const raw = event.payload.raw as { operation?: unknown; content?: unknown } | null;
        const op = raw && typeof raw === 'object' ? raw.operation : null;
        const content = raw && typeof raw === 'object' ? raw.content : null;
        if (op === 'enqueue' && typeof content === 'string') {
          const trimmed = content.trim();
          if (trimmed) ctx.scratch.pendingBtw.push(trimmed);
        }
        return true;
      }
      if (event.payload.record_type === 'attachment') {
        const raw = event.payload.raw as
          | { attachment?: { type?: unknown; prompt?: unknown } | null }
          | null;
        const att = raw && typeof raw === 'object' ? raw.attachment : null;
        const attType = att && typeof att === 'object' ? att.type : null;
        const prompt = att && typeof att === 'object' ? att.prompt : null;
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
            ctx.scratch.pendingReplyHolder = null;
            return true;
          }

          // Real /btw: emit the interjection as a plain user bubble.
          // refUuid intentionally points at this synthetic user bubble's uuid
          // (which is the meta event's uuid) so the quote can scroll to the
          // rendered bubble.
          items.push({
            type: 'bubble',
            event: { ...event, kind: 'user_text', payload: { text: prompt } } as Event,
            role: 'user',
            parts: [{ kind: 'text', text: prompt }],
          });
          ctx.scratch.pendingReply = { kind: 'btw', quote: prompt, refUuid: event.uuid };
          ctx.scratch.pendingReplyHolder = null;
          return true;
        }
        // Other attachment shapes fall through; defaultEventItem absorbs them.
        return false;
      }
    }
    if (event.kind !== 'user_text') return false;
    const text = event.payload.text ?? '';
    const trimmed = text.trim();
    if (!trimmed) return false;
    const idx = ctx.scratch.pendingBtw.indexOf(trimmed);
    if (idx < 0) {
      // Non-/btw fresh top-line prompt — clears any stale pending reply so a
      // new turn doesn't inherit a quote.
      ctx.scratch.pendingReply = null;
      ctx.scratch.pendingReplyHolder = null;
      return false;
    }
    ctx.scratch.pendingBtw.splice(idx, 1);
    if (isTaskNotification(trimmed)) {
      // Deferred task-notification: same classification as the inline path.
      const summary = parseSummary(text);
      items.push({
        type: 'notification-anchor',
        anchorUuid: event.uuid,
        summary,
        ts: event.ts,
      });
      ctx.scratch.pendingReply = { kind: 'task', quote: summary, refUuid: event.uuid };
    } else {
      items.push({
        type: 'bubble',
        event,
        role: 'user',
        parts: [{ kind: 'text', text }],
      });
      ctx.scratch.pendingReply = { kind: 'btw', quote: text, refUuid: event.uuid };
      ctx.scratch.pendingReplyHolder = null;
    }
    return true;
  },
};
