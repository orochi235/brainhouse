import type { Event } from '@server/parser.ts';
import type { Delta, PanelDto } from '@server/session.ts';
import { describe, expect, it } from 'vitest';
import { type Action, EVICT_CHUNK, initialState, LIVE_WINDOW, reducer } from './useDeltaStream.ts';

function panelDto(overrides: Partial<PanelDto> = {}): PanelDto {
  return {
    id: 'p1',
    kind: 'parent',
    parent_panel_id: null,
    title: 'p1',
    agent_type: null,
    task_description: null,
    account_label: null,
    iterm_session_id: null,
    status: 'live',
    started_at: 0,
    last_event_at: 0,
    status_changed_at: 0,
    event_count: 0,
    cwd: null,
    repo_root: null,
    theme: null,
    peer: null,
    binned_at: null,
    awaiting_input: false,
    ended: false,
    ended_provenance: null,
    tokens: { input: 0, output: 0, cache_create: 0, cache_read: 0, model: null },
    context_size: 0,
    hook_overhead_tokens: 0,
    manually_renamed: false,
    ...overrides,
  };
}

const ev: Event = {
  session_id: 'p1',
  agent_id: null,
  uuid: 'u1',
  parent_uuid: null,
  ts: '2026-05-19T00:00:00Z',
  cwd: null,
  kind: 'user_text',
  payload: { text: 'hi' },
} as Event;

describe('useDeltaStream reducer', () => {
  it('conn switches the connection status', () => {
    const next = reducer(initialState, { type: 'conn', status: 'live' });
    expect(next.status).toBe('live');
    expect(next.panels).toBe(initialState.panels);
  });

  it('snapshot hydrates the panel map and replaces prior state', () => {
    const after = reducer(initialState, {
      type: 'snapshot',
      panels: [{ ...panelDto({ id: 'a' }), events: [] }],
    });
    expect(after.panels.size).toBe(1);
    expect(after.panels.get('a')).toBeDefined();
  });

  it('panel_upsert inserts when absent and preserves events on update', () => {
    const withEvents = reducer(initialState, {
      type: 'snapshot',
      panels: [{ ...panelDto({ id: 'a' }), events: [ev] }],
    });
    const upserted = reducer(withEvents, {
      type: 'delta',
      delta: { op: 'panel_upsert', panel: panelDto({ id: 'a', title: 'new title' }) } as Delta,
    });
    expect(upserted.panels.get('a')?.title).toBe('new title');
    // Events are preserved across the upsert.
    expect(upserted.panels.get('a')?.events.length).toBe(1);
  });

  it('event_append pushes onto the panel events array immutably', () => {
    const seeded = reducer(initialState, {
      type: 'delta',
      delta: { op: 'panel_upsert', panel: panelDto({ id: 'a' }) } as Delta,
    });
    const appended = reducer(seeded, {
      type: 'delta',
      delta: { op: 'event_append', panel_id: 'a', event: ev } as Delta,
    });
    expect(appended.panels.get('a')?.events).toEqual([ev]);
    // Source array is untouched (immutability check).
    expect(seeded.panels.get('a')?.events).toEqual([]);
  });

  it('event_append takes last_event_at from the server, not arrival time', () => {
    const seeded = reducer(initialState, {
      type: 'delta',
      delta: { op: 'panel_upsert', panel: panelDto({ id: 'a', last_event_at: 0 }) } as Delta,
    });
    const next = reducer(seeded, {
      type: 'delta',
      delta: { op: 'event_append', panel_id: 'a', event: ev, last_event_at: 42 } as Delta,
    });
    expect(next.panels.get('a')?.last_event_at).toBe(42);
  });

  it('event_append silently drops an event for an unknown panel', () => {
    const next = reducer(initialState, {
      type: 'delta',
      delta: { op: 'event_append', panel_id: 'nope', event: ev } as Delta,
    });
    expect(next.panels.size).toBe(0);
  });

  it('panel_status takes status_changed_at and last_event_at from the server', () => {
    const seeded = reducer(initialState, {
      type: 'delta',
      delta: { op: 'panel_upsert', panel: panelDto({ id: 'a' }) } as Delta,
    });
    const next = reducer(seeded, {
      type: 'delta',
      delta: {
        op: 'panel_status',
        panel_id: 'a',
        status: 'done',
        status_changed_at: 70,
        last_event_at: 10,
      },
    });
    expect(next.panels.get('a')).toMatchObject({
      status: 'done',
      status_changed_at: 70,
      last_event_at: 10,
    });
  });

  const upsertA: Action = {
    type: 'delta',
    delta: { op: 'panel_upsert', panel: panelDto({ id: 'a' }) },
  };
  const removeA = (token: number): Action => ({
    type: 'delta',
    delta: { op: 'panel_remove', panel_id: 'a' },
    removalToken: token,
  });

  it('panel_remove soft-marks with its token without dropping', () => {
    const next = reducer(reducer(initialState, upsertA), removeA(7));
    expect(next.panels.get('a')?.removing).toBe(7);
  });

  it('commit_remove drops the panel when its token still matches', () => {
    const removing = reducer(reducer(initialState, upsertA), removeA(1));
    const next = reducer(removing, { type: 'commit_remove', panel_id: 'a', token: 1 });
    expect(next.panels.has('a')).toBe(false);
  });

  it('commit_remove spares a panel revived by an upsert during the fade', () => {
    const revived = reducer(reducer(reducer(initialState, upsertA), removeA(1)), upsertA);
    const next = reducer(revived, { type: 'commit_remove', panel_id: 'a', token: 1 });
    expect(next.panels.get('a')?.removing).toBeUndefined();
  });

  it('commit_remove spares a panel revived by a snapshot during the fade', () => {
    const removing = reducer(reducer(initialState, upsertA), removeA(1));
    const revived = reducer(removing, {
      type: 'snapshot',
      panels: [{ ...panelDto({ id: 'a' }), events: [] }],
    });
    const next = reducer(revived, { type: 'commit_remove', panel_id: 'a', token: 1 });
    expect(next.panels.has('a')).toBe(true);
  });

  it('a stale commit_remove does not cut short a later removal', () => {
    const s1 = reducer(reducer(initialState, upsertA), removeA(1));
    const s2 = reducer(reducer(s1, upsertA), removeA(2));
    const next = reducer(s2, { type: 'commit_remove', panel_id: 'a', token: 1 });
    expect(next.panels.get('a')?.removing).toBe(2);
  });

  it('snapshot wins over prior delta state', () => {
    const seeded = reducer(initialState, {
      type: 'delta',
      delta: { op: 'panel_upsert', panel: panelDto({ id: 'a' }) } as Delta,
    });
    const reset = reducer(seeded, {
      type: 'snapshot',
      panels: [{ ...panelDto({ id: 'b' }), events: [] }],
    });
    expect(reset.panels.has('a')).toBe(false);
    expect(reset.panels.has('b')).toBe(true);
  });
});

describe('useDeltaStream reducer — live window cap', () => {
  const evWith = (uuid: string): Event => ({ ...ev, uuid });

  it('keeps all events while under the cap', () => {
    let s = reducer(initialState, {
      type: 'snapshot',
      panels: [{ ...panelDto({ id: 'S' }), events: [] }],
    });
    for (let i = 0; i < LIVE_WINDOW; i++) {
      s = reducer(s, {
        type: 'delta',
        delta: { op: 'event_append', panel_id: 'S', event: evWith(`e${i}`) } as Delta,
      });
    }
    expect(s.panels.get('S')?.events.length).toBe(LIVE_WINDOW);
  });

  it('trims oldest in chunks once over the cap, preserving tail order', () => {
    let s = reducer(initialState, {
      type: 'snapshot',
      panels: [{ ...panelDto({ id: 'S' }), events: [] }],
    });
    // One past the cap triggers exactly one chunk trim, leaving the array
    // at LIVE_WINDOW - EVICT_CHUNK (it then re-grows toward LIVE_WINDOW).
    const total = LIVE_WINDOW + 1;
    for (let i = 0; i < total; i++) {
      s = reducer(s, {
        type: 'delta',
        delta: { op: 'event_append', panel_id: 'S', event: evWith(`e${i}`) } as Delta,
      });
    }
    const evs = s.panels.get('S')?.events ?? [];
    expect(evs.length).toBe(LIVE_WINDOW - EVICT_CHUNK);
    // newest event is always retained
    expect(evs.at(-1)?.uuid).toBe(`e${total - 1}`);
    // order is contiguous (no gaps from the splice)
    const nums = evs.map((e) => Number(e.uuid.slice(1)));
    expect(nums.every((n, i) => i === 0 || n === (nums[i - 1] ?? Number.NaN) + 1)).toBe(true);
  });

  it('caps the snapshot path to LIVE_WINDOW', () => {
    const events = Array.from({ length: LIVE_WINDOW + 500 }, (_, i) => evWith(`e${i}`));
    const s = reducer(initialState, {
      type: 'snapshot',
      panels: [{ ...panelDto({ id: 'S' }), events }],
    });
    expect(s.panels.get('S')?.events.length).toBe(LIVE_WINDOW);
    expect(s.panels.get('S')?.events.at(0)?.uuid).toBe(`e500`);
  });
});
