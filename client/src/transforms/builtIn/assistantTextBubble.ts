/**
 * Default assistant_text handler — emits an assistant bubble *unless* the
 * text is a true micro-ack and immediately follows a tool capsule, in
 * which case it's folded into the prior capsule's footer.
 *
 * Combines what used to be `foldToolAck` and the assistant_text bubble
 * branch — they shared the same kind, so colocating them keeps the
 * decision tree in one place.
 *
 * Fold heuristic (deliberately tight): ≤80 chars, single line, no code
 * fence, and no sentence-ending punctuation in the middle (so "Done."
 * folds but "Done. Tests pass." gets its own bubble). The threshold
 * used to be ≤200 chars, which let substantive end-of-turn summaries
 * disappear into a tool capsule's footer.
 */

import type { Stage1Transform } from '../types.ts';

const FOLD_MAX_LEN = 80;

function isFoldableAck(text: string): boolean {
  if (!text || text.length > FOLD_MAX_LEN) return false;
  if (text.includes('\n')) return false;
  if (text.includes('```')) return false;
  // Reject summary-shaped texts: anything with a period/!/? followed by
  // more characters reads as "statement + something else" — not an ack.
  if (/[.!?]\s+\S/.test(text)) return false;
  return true;
}

export const assistantTextBubble: Stage1Transform = {
  kind: 'view',
  stage: 1,
  key: 'built-in.assistant-text-bubble',
  name: 'foldToolAck + assistant_text bubble',
  description:
    'Emits an assistant bubble. A micro-ack assistant_text (<=80 chars, single line, no sentence boundary, no code fence) immediately after a tool capsule is folded into the capsule as its ack footer.',
  matches: ['assistant-text.any'],
  run(event, items, ctx) {
    if (event.kind !== 'assistant_text') return false; // type narrowing
    const text = (event.payload.text ?? '').trim();
    const last = items[items.length - 1];
    if (isFoldableAck(text) && last?.type === 'tool') {
      last.ack = text;
      return true;
    }
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
  },
};
