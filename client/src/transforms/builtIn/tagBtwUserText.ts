/**
 * Marks user_text bubbles that came in via `/btw` so they render distinct
 * from typed-at-the-prompt user turns.
 *
 * Claude Code writes two uuid-less side-channel records when the user fires
 * `/btw` mid-turn:
 *   { type: 'queue-operation', operation: 'enqueue', content: '<text>' }
 *   { type: 'attachment', attachment: { type: 'queued_command', prompt: '<text>' } }
 * Then on the next turn the same text arrives as a normal user_text.
 *
 * This transform watches for the `queue-operation` meta, stashes its content
 * in `ctx.scratch.pendingBtw`, and consumes the event (so the noisy meta
 * isn't rendered). When a later user_text whose trimmed text matches a
 * pending entry arrives, it emits the bubble with `btw: true` and pops the
 * entry. Non-/btw user_texts fall through to `userTextBubble`.
 */

import type { Stage1Transform } from '../types.ts';

export const tagBtwUserText: Stage1Transform = {
  kind: 'view',
  stage: 1,
  key: 'built-in.tag-btw-user-text',
  name: '/btw queue-operation → marked user bubble',
  description:
    'Pairs queue-operation meta records with the later user_text that delivers the queued prompt; emits the bubble with btw:true. Consumes the noisy queue-operation meta itself.',
  run(event, items, ctx) {
    if (event.kind === 'meta' && event.payload.record_type === 'queue-operation') {
      const raw = event.payload.raw as { operation?: unknown; content?: unknown } | null;
      const op = raw && typeof raw === 'object' ? raw.operation : null;
      const content = raw && typeof raw === 'object' ? raw.content : null;
      if (op === 'enqueue' && typeof content === 'string') {
        const trimmed = content.trim();
        if (trimmed) ctx.scratch.pendingBtw.push(trimmed);
      }
      return true;
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
