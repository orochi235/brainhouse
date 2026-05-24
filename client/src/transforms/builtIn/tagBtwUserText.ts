/**
 * Renders `/btw` interjections as marked user bubbles. Claude Code's /btw
 * has two side-channel shapes in the JSONL, both handled here:
 *
 * 1. **Inline delivery (Claude Code ≥ 2.1.13x).** The agent is mid-turn,
 *    the queued prompt is delivered as an `attachment` record with
 *    `attachment.type === 'queued_command'` and `attachment.prompt`. There
 *    is **no** follow-up `type:user` record carrying the same text. The
 *    `attachment` IS the user input. We emit a btw user bubble from
 *    `prompt`. A preceding `queue-operation` enqueue is bookkeeping noise
 *    that we still consume but don't need to match against.
 *
 * 2. **Deferred delivery (older flow).** The agent was idle, so the
 *    queued prompt eventually arrives as a normal `type:user` record with
 *    its own uuid. We stash any enqueued content from `queue-operation`
 *    in `ctx.scratch.pendingBtw` and mark the matching user_text as btw.
 *    Non-/btw user_texts fall through to `userTextBubble`.
 *
 * In both flows, `queue-operation` records (enqueue/dequeue/popAll/remove)
 * are consumed and never rendered — they're queue bookkeeping. Other
 * `attachment` shapes (hook_success, hook_additional_context, …) fall
 * through to `defaultEventItem`, which absorbs them.
 */

import type { Event } from '@server/parser.ts';
import type { Stage1Transform } from '../types.ts';

export const tagBtwUserText: Stage1Transform = {
  kind: 'view',
  stage: 1,
  key: 'built-in.tag-btw-user-text',
  name: '/btw queued prompt → marked user bubble',
  description:
    'Renders queued /btw prompts as user bubbles with btw:true — directly from queued_command attachment payloads, or by pairing queue-operation enqueues with a later user_text. Consumes the noisy queue-operation bookkeeping records.',
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
          // If a queue-operation enqueue already stashed this content,
          // pop it so a later user_text (if any arrives) doesn't double-render.
          const idx = ctx.scratch.pendingBtw.indexOf(trimmed);
          if (idx >= 0) ctx.scratch.pendingBtw.splice(idx, 1);
          items.push({
            type: 'bubble',
            event: { ...event, kind: 'user_text', payload: { text: prompt } } as Event,
            role: 'user',
            parts: [{ kind: 'text', text: prompt }],
            btw: true,
          });
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
    if (idx < 0) return false;
    ctx.scratch.pendingBtw.splice(idx, 1);
    items.push({
      type: 'bubble',
      event,
      role: 'user',
      parts: [{ kind: 'text', text }],
      btw: true,
    });
    return true;
  },
};
