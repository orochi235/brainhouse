/**
 * Default assistant_text handler — emits an assistant bubble *unless* the
 * text is short and immediately follows a tool capsule, in which case it's
 * treated as an acknowledgement ("let me check the logs") and folded into
 * the prior capsule's footer.
 *
 * Combines what used to be `foldToolAck` and the assistant_text bubble
 * branch — they shared the same kind, so colocating them keeps the
 * decision tree in one place.
 */

import type { Stage1Transform } from '../types.ts';

export const assistantTextBubble: Stage1Transform = {
  kind: 'view',
  stage: 1,
  key: 'built-in.assistant-text-bubble',
  name: 'foldToolAck + assistant_text bubble',
  description:
    'Emits an assistant bubble. A short assistant_text (<=200 chars, no blank line, no code fence) immediately after a tool capsule is folded into the capsule as its ack footer.',
  run(event, items, ctx) {
    if (event.kind !== 'assistant_text') return false;
    const text = (event.payload.text ?? '').trim();
    const last = items[items.length - 1];
    const isShort = text && text.length <= 200 && !text.includes('\n\n') && !text.includes('```');
    if (isShort && last?.type === 'tool') {
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
