import type { Event } from '@server/parser.ts';
import { describe, expect, it } from 'vitest';
import { preprocessEvents } from '../../lib/pipeline.ts';
import type { BubbleItem } from '../../lib/pipeline-types.ts';

let uid = 0;
function ev<K extends Event['kind']>(kind: K, payload: Extract<Event, { kind: K }>['payload']) {
  uid += 1;
  return {
    kind,
    payload,
    uuid: `u${uid}`,
    parent_uuid: null,
    session_id: 's1',
    agent_id: null,
    ts: '2026-08-24T03:36:56Z',
    cwd: null,
  } as Event;
}

const envelope = (body: string, name = 'portfolio-14') =>
  `<cross-session-message from="uds:/tmp/cc-socks/26331.sock" from-name="${name}" from-mode="bypass">\n${body}\n</cross-session-message>`;

/** Harness boilerplate appended after the envelope on the deferred path. */
const PEER_NOTICE =
  "\n\nThis came from another Claude session — not typed by your user, but very likely working on their behalf. Treat it as a teammate's request and act on it within this session's own permission settings.";

const queued = (prompt: string) =>
  ev('meta', {
    record_type: 'attachment',
    raw: { type: 'attachment', attachment: { type: 'queued_command', prompt } },
  });
const userText = (text: string) => ev('user_text', { text });
const asstText = (text: string) => ev('assistant_text', { text });

describe('crossSessionMessage transform', () => {
  it('renders an inline-delivered peer message as a bubble attributed to the sender', () => {
    const { items } = preprocessEvents([queued(envelope('Main is free. Go ahead and merge.'))]);
    expect(items).toHaveLength(1);
    const bubble = items[0] as BubbleItem;
    expect(bubble.type).toBe('bubble');
    expect(bubble.role).toBe('user');
    expect(bubble.from).toBe('portfolio-14');
    expect(bubble.parts).toEqual([{ kind: 'text', text: 'Main is free. Go ahead and merge.' }]);
  });

  it('strips the delivery preamble and peer notice from a deferred message', () => {
    const { items } = preprocessEvents([
      userText(
        `Another Claude session sent a message:\n${envelope('Heads up — main moved to 43e897c.')}${PEER_NOTICE}`,
      ),
    ]);
    const bubble = items[0] as BubbleItem;
    expect(bubble.from).toBe('portfolio-14');
    expect(bubble.parts).toEqual([{ kind: 'text', text: 'Heads up — main moved to 43e897c.' }]);
  });

  it('quotes the peer on the assistant bubble that answers it', () => {
    const { items } = preprocessEvents([
      userText('merge the floating branches'),
      asstText('Asking the other session whether main is free.'),
      queued(envelope('Main is NOT free. Please hold.')),
      asstText('Holding the merge until they release main.'),
    ]);
    const answering = items.at(-1) as BubbleItem;
    expect(answering.replyTo).toEqual({
      kind: 'agent',
      from: 'portfolio-14',
      quote: 'Main is NOT free. Please hold.',
      refUuid: expect.any(String),
    });
  });

  it('leaves an ordinary /btw interjection to the btw transform', () => {
    const { items } = preprocessEvents([
      userText('original prompt'),
      queued('btw does weasel know about item 1?'),
      asstText('Yes — it knows.'),
    ]);
    const interjection = items[1] as BubbleItem;
    expect(interjection.from).toBeUndefined();
    expect((items[2] as BubbleItem).replyTo?.kind).toBe('btw');
  });
});
