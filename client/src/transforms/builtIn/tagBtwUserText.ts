/**
 * Detects `/btw` interjections and flags the *next* assistant bubble as
 * btw — the user bubble itself renders normally. Claude Code's /btw has
 * two side-channel shapes in the JSONL, both handled here:
 *
 * 1. **Inline delivery (Claude Code ≥ 2.1.13x).** The agent is mid-turn,
 *    the queued prompt is delivered as an `attachment` record with
 *    `attachment.type === 'queued_command'` and `attachment.prompt`. There
 *    is **no** follow-up `type:user` record carrying the same text. The
 *    `attachment` IS the user input. We emit a plain user bubble from
 *    `prompt` and set `pendingBtwAssistant` so the next assistant_text
 *    bubble carries the btw chip.
 *
 * 2. **Deferred delivery (older flow).** The agent was idle, so the
 *    queued prompt eventually arrives as a normal `type:user` record with
 *    its own uuid. We stash any enqueued content from `queue-operation`
 *    in `ctx.scratch.pendingBtw` and, on the matching user_text, emit a
 *    plain user bubble and set `pendingBtwAssistant`. Non-/btw user_texts
 *    fall through to `userTextBubble`.
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
  name: '/btw queued prompt → flag next assistant bubble',
  description:
    'Detects queued /btw prompts (queued_command attachment payloads or queue-operation/user_text pairs) and sets pendingBtwAssistant so the next assistant bubble renders with btw:true. The queued prompt itself emits a plain user bubble. Consumes the noisy queue-operation bookkeeping records.',
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
          // If a queue-operation enqueue already stashed this content,
          // pop it so a later user_text (if any arrives) doesn't double-render.
          const idx = ctx.scratch.pendingBtw.indexOf(trimmed);
          if (idx >= 0) ctx.scratch.pendingBtw.splice(idx, 1);
          items.push({
            type: 'bubble',
            event: { ...event, kind: 'user_text', payload: { text: prompt } } as Event,
            role: 'user',
            parts: [{ kind: 'text', text: prompt }],
          });
          ctx.scratch.pendingBtwAssistant = true;
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
  },
};
