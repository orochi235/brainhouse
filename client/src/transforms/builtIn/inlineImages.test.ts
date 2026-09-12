import type { Event, ImageRef } from '@server/parser.ts';
import { describe, expect, it } from 'vitest';
import { preprocessEvents } from '../../lib/pipeline.ts';
import type { BubbleItem } from '../../lib/pipeline-types.ts';

const REF: ImageRef = {
  type: 'brainhouse-image',
  media_type: 'image/png',
  bytes: 4,
  sha256: 'a'.repeat(64),
};

function base(uuid: string): Omit<Event, 'kind' | 'payload'> {
  return {
    uuid,
    parent_uuid: null,
    session_id: 's1',
    agent_id: null,
    ts: '2026-06-08T00:00:00Z',
    cwd: null,
    tags: [],
  };
}

const userText = (uuid: string, text: string) =>
  ({ ...base(uuid), kind: 'user_text', payload: { text } }) as Event;

const image = (uuid: string, pasteId = 1) =>
  ({ ...base(uuid), kind: 'image', payload: { ref: REF, paste_id: pasteId } }) as Event;

describe('inlineImages transform', () => {
  it('attaches to its record bubble and drops the placeholder', () => {
    const { items } = preprocessEvents([
      userText('rec1:0', 'what happened here? [Image #1]'),
      image('rec1:1'),
    ]);
    expect(items).toHaveLength(1);
    const bubble = items[0] as BubbleItem;
    expect(bubble.parts).toEqual([
      { kind: 'text', text: 'what happened here?' },
      { kind: 'image', ref: REF, pasteId: 1 },
    ]);
  });

  it('strips only the placeholder for its own paste id', () => {
    const { items } = preprocessEvents([
      userText('rec2:0', 'compare [Image #1] against [Image #2]'),
      image('rec2:1', 1),
      image('rec2:2', 2),
    ]);
    const bubble = items[0] as BubbleItem;
    expect(bubble.parts[0]).toEqual({ kind: 'text', text: 'compare against' });
    expect(bubble.parts).toHaveLength(3);
  });

  it('opens its own bubble when the record produced no text', () => {
    const { items } = preprocessEvents([image('rec3:0')]);
    expect(items).toHaveLength(1);
    const bubble = items[0] as BubbleItem;
    expect(bubble.type).toBe('bubble');
    expect(bubble.role).toBe('user');
    expect(bubble.parts).toEqual([{ kind: 'image', ref: REF, pasteId: 1 }]);
  });

  it('does not graft onto a bubble from a different record', () => {
    const { items } = preprocessEvents([userText('rec4:0', 'earlier prompt'), image('rec5:0')]);
    expect(items).toHaveLength(2);
    expect((items[0] as BubbleItem).parts).toEqual([{ kind: 'text', text: 'earlier prompt' }]);
    expect((items[1] as BubbleItem).parts).toEqual([{ kind: 'image', ref: REF, pasteId: 1 }]);
  });
});
