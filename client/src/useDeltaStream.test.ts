import type { Event } from '@server/parser.ts';
import type { Delta, PanelDto } from '@server/session.ts';
import { describe, expect, it } from 'vitest';
import { EVICT_CHUNK, initialState, LIVE_WINDOW, reducer } from './useDeltaStream.ts';

function panelDto(overrides: Partial<PanelDto> = {}): PanelDto {
  return {
    id: 'p1',
    kind: 'parent',
    parent_panel_id: null,
    title: 'p1',
    agent_type: null,
    task_description: null,
    account_label: null,
    status: 'live',
    started_at: 0,
    last_event_at: 0,
    status_changed_at: 0,
    event_count: 0,
    cwd: null,
    repo_root: null,
    theme: null,
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

  it('event_append bumps last_event_at to the arrival time', () => {
    const seeded = reducer(initialState, {
      type: 'delta',
      delta: { op: 'panel_upsert', panel: panelDto({ id: 'a', last_event_at: 0 }) } as Delta,
    });
    const before = seeded.panels.get('a')?.last_event_at ?? -1;
    const next = reducer(seeded, {
      type: 'delta',
      delta: { op: 'event_append', panel_id: 'a', event: ev } as Delta,
    });
    expect(next.panels.get('a')?.last_event_at).toBeGreaterThan(before);
  });

  it('event_append silently drops an event for an unknown panel', () => {
    const next = reducer(initialState, {
      type: 'delta',
      delta: { op: 'event_append', panel_id: 'nope', event: ev } as Delta,
    });
    expect(next.panels.size).toBe(0);
  });

  it('panel_status updates status + bumps status_changed_at', () => {
    const seeded = reducer(initialState, {
      type: 'delta',
      delta: { op: 'panel_upsert', panel: panelDto({ id: 'a', status: 'live' }) } as Delta,
    });
    const before = seeded.panels.get('a')?.status_changed_at ?? 0;
    const next = reducer(seeded, {
      type: 'delta',
      delta: { op: 'panel_status', panel_id: 'a', status: 'done' } as Delta,
    });
    expect(next.panels.get('a')?.status).toBe('done');
    expect(next.panels.get('a')?.status_changed_at).toBeGreaterThan(before);
  });

  it('panel_remove soft-marks (removing: true) without dropping', () => {
    const seeded = reducer(initialState, {
      type: 'delta',
      delta: { op: 'panel_upsert', panel: panelDto({ id: 'a' }) } as Delta,
    });
    const next = reducer(seeded, {
      type: 'delta',
      delta: { op: 'panel_remove', panel_id: 'a' } as Delta,
    });
    expect(next.panels.get('a')?.removing).toBe(true);
  });

  it('commit_remove drops the panel for real', () => {
    const seeded = reducer(initialState, {
      type: 'delta',
      delta: { op: 'panel_upsert', panel: panelDto({ id: 'a' }) } as Delta,
    });
    const next = reducer(seeded, { type: 'commit_remove', panel_id: 'a' });
    expect(next.panels.has('a')).toBe(false);
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
