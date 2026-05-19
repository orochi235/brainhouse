import { describe, expect, it } from 'vitest';
import type { Event, EventKind } from './parser.js';
import { SessionStore } from './session.js';

class FakeClock {
  constructor(public t = 1000) {}
  now = () => this.t;
  advance(dt: number) {
    this.t += dt;
  }
}

function ev(
  kind: EventKind,
  opts: {
    session_id?: string;
    agent_id?: string | null;
    uuid?: string;
    payload?: unknown;
    cwd?: string | null;
  } = {},
): Event {
  return {
    session_id: opts.session_id ?? 'S',
    agent_id: opts.agent_id ?? null,
    uuid: opts.uuid ?? 'u',
    parent_uuid: null,
    ts: 't',
    cwd: opts.cwd ?? null,
    kind,
    payload: opts.payload ?? {},
  } as Event;
}

describe('SessionStore', () => {
  it('first event creates a parent panel', () => {
    const clock = new FakeClock();
    const store = new SessionStore({ clock: clock.now });
    const deltas = store.apply(ev('user_text', { payload: { text: 'hi' } }));
    expect(deltas.map((d) => d.op)).toEqual(['panel_upsert', 'event_append']);
    if (deltas[0]?.op === 'panel_upsert') {
      expect(deltas[0].panel.id).toBe('S');
      expect(deltas[0].panel.kind).toBe('parent');
      expect(deltas[0].panel.status).toBe('live');
    }
  });

  it('second event appends without re-creating the panel', () => {
    const clock = new FakeClock();
    const store = new SessionStore({ clock: clock.now });
    store.apply(ev('user_text', { uuid: 'u1', payload: { text: 'a' } }));
    clock.advance(5);
    const deltas = store.apply(ev('assistant_text', { uuid: 'u2', payload: { text: 'b' } }));
    expect(deltas.map((d) => d.op)).toEqual(['event_append']);
    expect(store.snapshot()).toHaveLength(1);
  });

  it('subagent creates a child panel linked to parent', () => {
    const clock = new FakeClock();
    const store = new SessionStore({ clock: clock.now });
    store.apply(ev('user_text', { uuid: 'u1', payload: { text: 'parent' } }));
    const deltas = store.apply(
      ev('user_text', { agent_id: 'agent-abc', uuid: 'u2', payload: { text: 'child' } }),
    );
    const upsert = deltas.find((d) => d.op === 'panel_upsert');
    if (upsert?.op === 'panel_upsert') {
      expect(upsert.panel.id).toBe('agent-abc');
      expect(upsert.panel.kind).toBe('subagent');
      expect(upsert.panel.parent_panel_id).toBe('S');
    } else throw new Error('expected panel_upsert');
  });

  it('subagent-meta updates the title', () => {
    const clock = new FakeClock();
    const store = new SessionStore({ clock: clock.now });
    store.apply(ev('user_text', { agent_id: 'agent-abc', uuid: 'u1', payload: { text: 'hi' } }));
    const deltas = store.apply(
      ev('meta', {
        agent_id: 'agent-abc',
        uuid: 'agent-abc:meta',
        payload: {
          record_type: 'subagent-meta',
          raw: { agentType: 'Explore', description: 'Explore cultivar editor code' },
        },
      }),
    );
    const upserts = deltas.filter((d) => d.op === 'panel_upsert');
    expect(upserts.length).toBeGreaterThan(0);
    const last = upserts[upserts.length - 1];
    if (last?.op === 'panel_upsert') {
      expect(last.panel.title).toMatch(/Explore/);
      expect(last.panel.title).toMatch(/cultivar/);
    }
  });

  it('idle panel transitions to done', () => {
    const clock = new FakeClock();
    const store = new SessionStore({ idleSeconds: 60, miniSeconds: 600, clock: clock.now });
    store.apply(ev('user_text', { payload: { text: 'hi' } }));
    clock.advance(30);
    expect(store.tick()).toEqual([]);
    clock.advance(31);
    expect(store.tick()).toEqual([{ op: 'panel_status', panel_id: 'S', status: 'done' }]);
    expect(store.panel('S')?.status).toBe('done');
  });

  it('done panel transitions to mini', () => {
    const clock = new FakeClock();
    const store = new SessionStore({ idleSeconds: 10, miniSeconds: 100, clock: clock.now });
    store.apply(ev('user_text', { payload: { text: 'hi' } }));
    clock.advance(11);
    store.tick();
    clock.advance(101);
    expect(store.tick()).toEqual([{ op: 'panel_status', panel_id: 'S', status: 'mini' }]);
  });

  it('mini panel is removed after removeAfterSeconds', () => {
    const clock = new FakeClock();
    const store = new SessionStore({
      idleSeconds: 10,
      miniSeconds: 100,
      removeAfterSeconds: 1000,
      clock: clock.now,
    });
    store.apply(ev('user_text', { payload: { text: 'hi' } }));
    clock.advance(11);
    store.tick();
    clock.advance(101);
    store.tick();
    clock.advance(1001);
    expect(store.tick()).toEqual([{ op: 'panel_remove', panel_id: 'S' }]);
    expect(store.panel('S')).toBeUndefined();
  });

  it('new event revives a done panel', () => {
    const clock = new FakeClock();
    const store = new SessionStore({ idleSeconds: 10, miniSeconds: 100, clock: clock.now });
    store.apply(ev('user_text', { uuid: 'u1', payload: { text: 'a' } }));
    clock.advance(11);
    store.tick();
    expect(store.panel('S')?.status).toBe('done');
    clock.advance(1);
    const deltas = store.apply(ev('user_text', { uuid: 'u2', payload: { text: 'b' } }));
    const statusChanges = deltas.filter((d) => d.op === 'panel_status');
    expect(statusChanges).toEqual([{ op: 'panel_status', panel_id: 'S', status: 'live' }]);
  });

  it('forceStatus emits delta and changes state', () => {
    const clock = new FakeClock();
    const store = new SessionStore({ clock: clock.now });
    store.apply(ev('user_text', { payload: { text: 'hi' } }));
    expect(store.forceStatus('S', 'done')).toEqual([
      { op: 'panel_status', panel_id: 'S', status: 'done' },
    ]);
    expect(store.panel('S')?.status).toBe('done');
  });

  it('forceStatus is a no-op when unchanged', () => {
    const clock = new FakeClock();
    const store = new SessionStore({ clock: clock.now });
    store.apply(ev('user_text', { payload: { text: 'hi' } }));
    expect(store.forceStatus('S', 'live')).toEqual([]);
  });

  it('remove returns panel_remove delta and deletes', () => {
    const clock = new FakeClock();
    const store = new SessionStore({ clock: clock.now });
    store.apply(ev('user_text', { payload: { text: 'hi' } }));
    expect(store.remove('S')).toEqual([{ op: 'panel_remove', panel_id: 'S' }]);
    expect(store.panel('S')).toBeUndefined();
    expect(store.remove('S')).toEqual([]);
  });

  it('snapshot serializes panels with events', () => {
    const clock = new FakeClock();
    const store = new SessionStore({ clock: clock.now });
    store.apply(ev('user_text', { payload: { text: 'hi' } }));
    store.apply(ev('user_text', { agent_id: 'agent-x', uuid: 'u2', payload: { text: 'sub' } }));
    const snap = store.snapshot();
    expect(snap).toHaveLength(2);
    expect(new Set(snap.map((p) => p.id))).toEqual(new Set(['S', 'agent-x']));
    for (const p of snap) {
      expect(p.events.length).toBeGreaterThan(0);
      expect(p.event_count).toBe(p.events.length);
    }
  });
});
