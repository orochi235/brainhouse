import { describe, expect, it } from 'vitest';
import type { Event } from './parser.js';
import { sliceHistory } from './history.js';

function ev(uuid: string): Event {
  return { kind: 'assistant_text', uuid, parent_uuid: null, ts: '2026-01-01T00:00:00Z' } as Event;
}

const all = ['a', 'b', 'c', 'd', 'e'].map(ev); // chronological

describe('sliceHistory', () => {
  it('returns the `limit` events immediately before the cursor', () => {
    const r = sliceHistory(all, 'd', 2);
    expect(r.events.map((e) => e.uuid)).toEqual(['b', 'c']);
    expect(r.hasMore).toBe(true); // 'a' is still older than 'b'
  });

  it('clamps at the start of the file and reports hasMore=false', () => {
    const r = sliceHistory(all, 'c', 10);
    expect(r.events.map((e) => e.uuid)).toEqual(['a', 'b']);
    expect(r.hasMore).toBe(false);
  });

  it('returns empty + hasMore=false when the cursor is the first event', () => {
    const r = sliceHistory(all, 'a', 5);
    expect(r.events).toEqual([]);
    expect(r.hasMore).toBe(false);
  });

  it('returns empty + hasMore=false when the cursor is unknown', () => {
    const r = sliceHistory(all, 'zzz', 5);
    expect(r.events).toEqual([]);
    expect(r.hasMore).toBe(false);
  });
});
