/**
 * Renders a message from another Claude Code session as a bubble attributed
 * to the sending session, rather than as something the user typed.
 *
 * `SendMessage` delivers to the recipient in one of two shapes, depending on
 * whether it was mid-turn when the message landed:
 *
 *   - **inline** — an `attachment` record with `attachment.type ===
 *     'queued_command'`, the same side channel `/btw` uses.
 *   - **deferred** — an ordinary `user_text` record, prefixed with
 *     "Another Claude session sent a message:" and followed by the harness's
 *     standing peer-message notice.
 *
 * Both carry a `<cross-session-message from-name="…">` envelope, which is
 * what we key on. Everything outside the envelope is delivery machinery, so
 * only the body reaches the bubble.
 *
 * Runs ahead of `tagBtwUserText`, which would otherwise classify the inline
 * shape as a `/btw` interjection and render the raw envelope markup.
 */

import type { Event } from '@server/parser.ts';
import type { Stage1Transform } from '../types.ts';

interface PeerMessage {
  from: string;
  body: string;
}

const ENVELOPE = /<cross-session-message\b([^>]*)>([\s\S]*?)<\/cross-session-message>/;

/** Pull the sender and body out of a delivered peer message. Returns null
 * for any text that isn't one, so non-peer traffic falls through untouched. */
function parseEnvelope(text: string): PeerMessage | null {
  const m = text.match(ENVELOPE);
  if (!m) return null;
  const attrs = m[1] ?? '';
  const from = attrs.match(/\bfrom-name="([^"]*)"/)?.[1] ?? attrs.match(/\bfrom="([^"]*)"/)?.[1];
  if (!from) return null;
  return { from, body: (m[2] ?? '').trim() };
}

export const crossSessionMessage: Stage1Transform = {
  kind: 'view',
  stage: 1,
  key: 'built-in.cross-session-message',
  name: 'peer session message → attributed bubble',
  description:
    'Detects `<cross-session-message>` envelopes delivered by SendMessage, in either the inline (queued_command attachment) or deferred (user_text) shape. Emits a user-side bubble carrying only the message body and stamped with the sending session name, and sets pendingReply { kind: "agent" } so the answering assistant bubble quotes the peer.',
  matches: ['meta.any', 'user-text.any'],
  run(event, items, ctx) {
    const text = deliveredText(event);
    if (text === null) return false;
    const peer = parseEnvelope(text);
    if (!peer) return false;

    // A queue-operation enqueue may have stashed this delivery for
    // `tagBtwUserText`; drop it so the entry can't match a later prompt.
    const idx = ctx.scratch.pendingBtw.indexOf(text.trim());
    if (idx >= 0) ctx.scratch.pendingBtw.splice(idx, 1);

    items.push({
      type: 'bubble',
      event: { ...event, kind: 'user_text', payload: { text: peer.body } } as Event,
      role: 'user',
      parts: [{ kind: 'text', text: peer.body }],
      from: peer.from,
    });
    ctx.scratch.pendingReply = {
      kind: 'agent',
      from: peer.from,
      quote: peer.body,
      refUuid: event.uuid,
    };
    ctx.scratch.pendingReplyHolder = null;
    return true;
  },
};

/** The prompt text an event delivered, across both shapes — or null if this
 * event isn't a delivery at all. */
function deliveredText(event: Event): string | null {
  if (event.kind === 'user_text') return event.payload.text ?? null;
  if (event.kind !== 'meta' || event.payload.record_type !== 'attachment') return null;
  const raw = event.payload.raw as { attachment?: { type?: unknown; prompt?: unknown } } | null;
  const att = raw && typeof raw === 'object' ? raw.attachment : null;
  if (!att || typeof att !== 'object' || att.type !== 'queued_command') return null;
  return typeof att.prompt === 'string' ? att.prompt : null;
}
