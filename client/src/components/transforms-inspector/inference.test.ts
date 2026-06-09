import { describe, expect, it } from 'vitest';
import type { Event } from '@server/parser.ts';
import { infer } from './inference.ts';

function mk(partial: Partial<Event> & { kind: string }): Event {
  return {
    uuid: 'u',
    parent_uuid: null,
    session_id: 's',
    ts: 0,
    ...partial,
  } as unknown as Event;
}

describe('infer()', () => {
  it('falls back to event[kind=...] for unknown kinds', () => {
    expect(infer(mk({ kind: 'mystery', payload: {} } as never))).toBe('event[kind=mystery]');
  });

  it('adds a tool_use[name=...] segment when tool_use has a name', () => {
    const out = infer(
      mk({
        kind: 'tool_use',
        payload: { tool_use_id: 't', name: 'Bash', input: {} },
      } as never),
    );
    expect(out).toBe('event[kind=tool_use] > tool_use[name=Bash]');
  });

  it('emits a plain tool_result segment', () => {
    const out = infer(
      mk({
        kind: 'tool_result',
        payload: { tool_use_id: 't', content: '', is_error: false },
      } as never),
    );
    expect(out).toBe('event[kind=tool_result] > tool_result');
  });

  it('detects a <bash-input> marker on user_text', () => {
    const out = infer(
      mk({ kind: 'user_text', payload: { text: '<bash-input>ls</bash-input>' } } as never),
    );
    expect(out).toBe('event[kind=user_text] > text[contains=<bash-input]');
  });

  it('detects a <bh-title> marker on assistant_text', () => {
    const out = infer(
      mk({ kind: 'assistant_text', payload: { text: 'hi <bh-title>x</bh-title>' } } as never),
    );
    expect(out).toBe('event[kind=assistant_text] > text[contains=<bh-title]');
  });

  it('adds meta[kind=...] when meta payload carries a kind', () => {
    const out = infer(mk({ kind: 'meta', payload: { kind: 'queue-operation' } } as never));
    expect(out).toBe('event[kind=meta] > meta[kind=queue-operation]');
  });

  it('emits bare event[kind=meta] when no meta kind is present', () => {
    expect(infer(mk({ kind: 'meta', payload: {} } as never))).toBe('event[kind=meta]');
  });
});
