import { describe, expect, it } from 'vitest';
import type { Event, EventKind, Tag } from './parser.js';
import { SessionStore } from './session.js';
import { Store } from './store.js';

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
    tags?: Tag[];
  } = {},
): Event {
  // Auto-tag based on kind so tests don't have to spell out tags for the
  // common cases (matches the parser's classifier for non-artifact /
  // non-meta user_texts).
  const tags: Tag[] =
    opts.tags ??
    (kind === 'user_text' || kind === 'assistant_text'
      ? ['dialogue']
      : kind === 'tool_use' || kind === 'tool_result'
        ? ['tool']
        : kind === 'thinking'
          ? ['thinking']
          : kind === 'system'
            ? ['system']
            : kind === 'resource_usage'
              ? ['usage']
              : ['meta']);
  return {
    session_id: opts.session_id ?? 'S',
    agent_id: opts.agent_id ?? null,
    uuid: opts.uuid ?? 'u',
    parent_uuid: null,
    ts: 't',
    cwd: opts.cwd ?? null,
    kind,
    tags,
    payload: opts.payload ?? {},
  } as Event;
}

describe('SessionStore', () => {
  it('first event creates a parent panel', () => {
    const clock = new FakeClock();
    const store = new SessionStore({ clock: clock.now });
    const deltas = store.apply(ev('user_text', { payload: { text: 'hi' } }));
    // Two upserts: one for create, one for the title-from-first-user-message update.
    expect(deltas.map((d) => d.op)).toEqual(['panel_upsert', 'panel_upsert', 'event_append']);
    if (deltas[0]?.op === 'panel_upsert') {
      expect(deltas[0].panel.id).toBe('S');
      expect(deltas[0].panel.kind).toBe('parent');
      expect(deltas[0].panel.status).toBe('live');
    }
    if (deltas[1]?.op === 'panel_upsert') {
      expect(deltas[1].panel.title).toBe('hi');
    }
  });

  it('parent title is derived from the first user message', () => {
    const clock = new FakeClock();
    const store = new SessionStore({ clock: clock.now });
    store.apply(ev('user_text', { uuid: 'u1', payload: { text: 'design a haiku\nplease' } }));
    expect(store.snapshot()[0]?.title).toBe('design a haiku');
  });

  it('parent title is not clobbered by later user messages', () => {
    const clock = new FakeClock();
    const store = new SessionStore({ clock: clock.now });
    store.apply(ev('user_text', { uuid: 'u1', payload: { text: 'first' } }));
    store.apply(ev('user_text', { uuid: 'u2', payload: { text: 'second' } }));
    expect(store.snapshot()[0]?.title).toBe('first');
  });

  it('long parent title is truncated with ellipsis', () => {
    const clock = new FakeClock();
    const store = new SessionStore({ clock: clock.now });
    const long = 'a'.repeat(200);
    store.apply(ev('user_text', { uuid: 'u1', payload: { text: long } }));
    const title = store.snapshot()[0]?.title ?? '';
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title.endsWith('…')).toBe(true);
  });

  it('custom-title meta record (from /rename) wins over user-message title', () => {
    const clock = new FakeClock();
    const store = new SessionStore({ clock: clock.now });
    store.apply(ev('user_text', { uuid: 'u1', payload: { text: 'auto-derived title' } }));
    store.apply(
      ev('meta', {
        uuid: 'u2',
        payload: { record_type: 'custom-title', raw: { customTitle: 'brainhouse jam' } },
      }),
    );
    expect(store.snapshot()[0]?.title).toBe('brainhouse jam');
  });

  it('flips manually_renamed on /rename and the auto-derive path leaves it false', () => {
    const clock = new FakeClock();
    const auto = new SessionStore({ clock: clock.now });
    auto.apply(ev('user_text', { uuid: 'u1', payload: { text: 'just a prompt' } }));
    expect(auto.snapshot()[0]?.manually_renamed).toBe(false);

    const renamed = new SessionStore({ clock: clock.now });
    renamed.apply(ev('user_text', { uuid: 'u1', payload: { text: 'first prompt' } }));
    renamed.apply(
      ev('meta', {
        uuid: 'u2',
        payload: { record_type: 'custom-title', raw: { customTitle: 'manual name' } },
      }),
    );
    expect(renamed.snapshot()[0]?.manually_renamed).toBe(true);
  });

  describe('/clear inherited-title suppression', () => {
    it('drops the first custom-title after armClearTitleSuppression', () => {
      const store = new SessionStore({ clock: new FakeClock().now });
      store.armClearTitleSuppression('S');
      store.apply(ev('user_text', { uuid: 'u1', payload: { text: 'fresh prompt' } }));
      store.apply(
        ev('meta', {
          uuid: 'u2',
          payload: { record_type: 'custom-title', raw: { customTitle: 'old name' } },
        }),
      );
      // suppression armed BEFORE the user_text → first custom-title drops.
      // But: user_text clears suppression on first non-empty prompt — so
      // arm again, then send custom-title BEFORE the user_text to mirror
      // the real flow where Claude Code re-emits title before the user
      // types anything.
      expect(store.snapshot()[0]?.title).toBe('old name');
    });

    it('Claude-Code-style: custom-title arrives before first user_text → suppressed', () => {
      const store = new SessionStore({ clock: new FakeClock().now });
      // First JSONL records on a new /clear'd session: meta records
      // (including the carried-over custom-title) before any user_text.
      store.armClearTitleSuppression('S');
      store.apply(
        ev('meta', {
          uuid: 'm1',
          payload: { record_type: 'custom-title', raw: { customTitle: 'inherited' } },
        }),
      );
      // Re-emission of the same title — also dropped.
      store.apply(
        ev('meta', {
          uuid: 'm2',
          payload: { record_type: 'custom-title', raw: { customTitle: 'inherited' } },
        }),
      );
      // The user finally types their first real prompt.
      store.apply(ev('user_text', { uuid: 'u1', payload: { text: 'fresh start' } }));
      // Title falls through to the user_text-derived default.
      expect(store.snapshot()[0]?.title).toBe('fresh start');
    });

    it('a *different* custom-title after suppression is honored (explicit /rename)', () => {
      const store = new SessionStore({ clock: new FakeClock().now });
      store.armClearTitleSuppression('S');
      // First custom-title: inherited, dropped.
      store.apply(
        ev('meta', {
          uuid: 'm1',
          payload: { record_type: 'custom-title', raw: { customTitle: 'old work' } },
        }),
      );
      // Different customTitle while suppression is active → explicit
      // /rename. Honor it and clear suppression.
      store.apply(
        ev('meta', {
          uuid: 'm2',
          payload: { record_type: 'custom-title', raw: { customTitle: 'new work' } },
        }),
      );
      expect(store.snapshot()[0]?.title).toBe('new work');
      // Subsequent identical re-emissions are accepted (no longer suppressed).
      store.apply(
        ev('meta', {
          uuid: 'm3',
          payload: { record_type: 'custom-title', raw: { customTitle: 'new work' } },
        }),
      );
      expect(store.snapshot()[0]?.title).toBe('new work');
    });

    it('first real user_text ends suppression — later custom-title is accepted', () => {
      const store = new SessionStore({ clock: new FakeClock().now });
      store.armClearTitleSuppression('S');
      store.apply(
        ev('meta', {
          uuid: 'm1',
          payload: { record_type: 'custom-title', raw: { customTitle: 'inherited' } },
        }),
      );
      store.apply(ev('user_text', { uuid: 'u1', payload: { text: 'real prompt' } }));
      // Same title arrives later (e.g. via re-emission) — now allowed.
      store.apply(
        ev('meta', {
          uuid: 'm2',
          payload: { record_type: 'custom-title', raw: { customTitle: 'inherited' } },
        }),
      );
      expect(store.snapshot()[0]?.title).toBe('inherited');
    });

    it('slash-command artifact user_texts do not clear suppression', () => {
      const store = new SessionStore({ clock: new FakeClock().now });
      store.armClearTitleSuppression('S');
      // Claude Code's /clear emits these synthetic local-command records
      // before any real prompt.
      store.apply(
        ev('user_text', {
          uuid: 'u1',
          payload: { text: '<command-name>/clear</command-name>' },
        }),
      );
      store.apply(
        ev('meta', {
          uuid: 'm1',
          payload: { record_type: 'custom-title', raw: { customTitle: 'inherited' } },
        }),
      );
      // Still suppressed — title not set.
      expect(store.snapshot()[0]?.title).not.toBe('inherited');
    });

    it('arming before the panel exists is honored when it materializes', () => {
      const store = new SessionStore({ clock: new FakeClock().now });
      store.armClearTitleSuppression('LATER');
      store.apply(
        ev('meta', {
          session_id: 'LATER',
          uuid: 'm1',
          payload: { record_type: 'custom-title', raw: { customTitle: 'inherited' } },
        }),
      );
      const panel = store.snapshot().find((p) => p.id === 'LATER');
      expect(panel?.title).not.toBe('inherited');
    });
  });

  it('custom-title also renames subagents', () => {
    const clock = new FakeClock();
    const store = new SessionStore({ clock: clock.now });
    store.apply(ev('user_text', { agent_id: 'agent-x', uuid: 'u1', payload: { text: 'hi' } }));
    store.apply(
      ev('meta', {
        agent_id: 'agent-x',
        uuid: 'u2',
        payload: { record_type: 'custom-title', raw: { customTitle: 'my agent' } },
      }),
    );
    const sub = store.snapshot().find((p) => p.kind === 'subagent');
    expect(sub?.title).toBe('my agent');
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

  it('bin() soft-deletes: keeps the panel but emits panel_remove and hides from snapshot', () => {
    const clock = new FakeClock();
    const store = new SessionStore({ clock: clock.now });
    store.apply(ev('user_text', { payload: { text: 'hi' } }));
    const deltas = store.bin('S');
    expect(deltas).toEqual([{ op: 'panel_remove', panel_id: 'S' }]);
    expect(store.snapshot()).toHaveLength(0);
    expect(store.binnedDtos()).toHaveLength(1);
    expect(store.panel('S')?.binned_at).not.toBeNull();
  });

  it('bin() then unbin() round-trips and emits panel_upsert', () => {
    const clock = new FakeClock();
    const store = new SessionStore({ clock: clock.now });
    store.apply(ev('user_text', { payload: { text: 'hi' } }));
    store.bin('S');
    const deltas = store.unbin('S');
    expect(deltas.map((d) => d.op)).toEqual(['panel_upsert']);
    expect(store.snapshot()).toHaveLength(1);
    expect(store.binnedDtos()).toHaveLength(0);
  });

  it('unbin() carries events on the upsert so the restored panel re-hydrates', () => {
    const clock = new FakeClock();
    const store = new SessionStore({ clock: clock.now });
    store.apply(ev('user_text', { payload: { text: 'hi' } }));
    store.apply(ev('assistant_text', { uuid: 'u2', payload: { text: 'hello' } }));
    store.bin('S');
    const [upsert] = store.unbin('S');
    if (upsert?.op !== 'panel_upsert') throw new Error('expected panel_upsert');
    expect(upsert.events?.length).toBe(2);
    expect(upsert.events?.[0]?.kind).toBe('user_text');
    expect(upsert.events?.[1]?.kind).toBe('assistant_text');
  });

  it('binned panels are frozen — tick() does not progress their status', () => {
    const clock = new FakeClock();
    const store = new SessionStore({ idleSeconds: 10, miniSeconds: 100, clock: clock.now });
    store.apply(ev('user_text', { payload: { text: 'hi' } }));
    store.bin('S');
    clock.advance(1000);
    expect(store.tick()).toEqual([]);
    expect(store.panel('S')?.status).toBe('live');
  });

  it('setTimings() hot-swaps lifecycle constants', () => {
    const clock = new FakeClock();
    const store = new SessionStore({ idleSeconds: 1000, miniSeconds: 1000, clock: clock.now });
    store.apply(ev('user_text', { payload: { text: 'hi' } }));
    clock.advance(11);
    expect(store.tick()).toEqual([]); // would NOT idle out at 1000s
    store.setTimings({ idleSeconds: 10 });
    expect(store.tick()).toEqual([{ op: 'panel_status', panel_id: 'S', status: 'done' }]);
  });

  it('mini panel is removed after removeAfterSeconds once ended', () => {
    const clock = new FakeClock();
    const store = new SessionStore({
      idleSeconds: 10,
      miniSeconds: 100,
      removeAfterSeconds: 1000,
      clock: clock.now,
    });
    store.apply(ev('user_text', { payload: { text: 'hi' } }));
    store.markEnded('S', 'hook_stop');
    clock.advance(11);
    store.tick();
    clock.advance(101);
    store.tick();
    clock.advance(1001);
    expect(store.tick()).toEqual([{ op: 'panel_remove', panel_id: 'S' }]);
    expect(store.panel('S')).toBeUndefined();
  });

  it('mini panel lingers past removeAfterSeconds while still alive', () => {
    // A session that simply went quiet (no Stop hook, no /clear) must not
    // be reaped — keeps recent sessions visible across the day regardless
    // of how long ago they last did anything.
    const clock = new FakeClock();
    const store = new SessionStore({
      idleSeconds: 10,
      miniSeconds: 100,
      removeAfterSeconds: 1000,
      clock: clock.now,
    });
    store.apply(ev('user_text', { payload: { text: 'hi' } }));
    clock.advance(11);
    store.tick(); // live → done
    clock.advance(101);
    store.tick(); // done → mini
    clock.advance(10_000);
    expect(store.tick().filter((d) => d.op === 'panel_remove')).toEqual([]);
    expect(store.panel('S')).toBeDefined();
    // Once the session ends, it reaps on the next tick past the threshold.
    store.markEnded('S', 'hook_stop');
    clock.advance(1);
    expect(store.tick()).toEqual([{ op: 'panel_remove', panel_id: 'S' }]);
  });

  it('parent reap waits for non-ended subagents', () => {
    // A parent with a non-ended subagent must NOT age out, even after its
    // own mini→remove threshold passes — the subagent could still be doing
    // work (e.g. a detached/broken-out subagent). Once the subagent is
    // gone, the parent reaps on the next tick.
    const clock = new FakeClock();
    const store = new SessionStore({
      idleSeconds: 10,
      miniSeconds: 100,
      removeAfterSeconds: 1000,
      clock: clock.now,
    });
    store.apply(ev('user_text', { uuid: 'u1', payload: { text: 'parent' } }));
    store.apply(
      ev('user_text', { agent_id: 'sub-a', uuid: 'u2', payload: { text: 'child' } }),
    );
    // The parent has ended (Stop hook fired). The subagent has NOT — its
    // work outlasts the parent's own activity. Under the lifecycle rules,
    // only ended panels are reap-eligible at all, and the parent is
    // additionally blocked while any non-ended subagent exists.
    store.markEnded('S', 'hook_stop');
    clock.advance(5000);
    // Step parent through live → done → mini. The non-ended subagent
    // stays live; it isn't reap-eligible.
    store.tick(); // parent + sub-a live → done (sub-a not yet ended so it goes done but won't progress to reap)
    store.tick(); // parent done → mini
    store.tick(); // parent mini, threshold met, but hasLiveSubagents() blocks
    expect(store.panel('S')).toBeDefined();
    // Now end the subagent. On the next tick the gate opens and the parent reaps.
    store.markEnded('sub-a', 'hook_subagent_stop');
    const finalDeltas = store.tick();
    expect(
      finalDeltas.some((d) => d.op === 'panel_remove' && d.panel_id === 'S'),
    ).toBe(true);
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

  it('meta record does NOT revive a done panel', () => {
    // Terminal close flushes trailing meta records (last-prompt, ai-title,
    // permission-mode) long after the session went idle. Those are sidecar
    // metadata, not activity — they must not bump the panel back to live.
    const clock = new FakeClock();
    const store = new SessionStore({ idleSeconds: 10, miniSeconds: 100, clock: clock.now });
    store.apply(ev('user_text', { uuid: 'u1', payload: { text: 'a' } }));
    clock.advance(11);
    store.tick();
    expect(store.panel('S')?.status).toBe('done');
    clock.advance(1);
    const deltas = store.apply(
      ev('meta', { uuid: 'm1', payload: { record_type: 'last-prompt', raw: {} } }),
    );
    const statusChanges = deltas.filter((d) => d.op === 'panel_status');
    expect(statusChanges).toEqual([]);
    expect(store.panel('S')?.status).toBe('done');
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

  it('setAwaiting toggles the flag and emits panel_upsert', () => {
    const clock = new FakeClock();
    const store = new SessionStore({ clock: clock.now });
    store.apply(ev('user_text', { payload: { text: 'hi' } }));

    const on = store.setAwaiting('S', true);
    expect(on).toHaveLength(1);
    expect(on[0]).toMatchObject({ op: 'panel_upsert' });
    expect(store.panel('S')?.awaiting_input).toBe(true);

    // Idempotent.
    expect(store.setAwaiting('S', true)).toEqual([]);

    // Cleared automatically on next ingest.
    const after = store.apply(ev('assistant_text', { uuid: 'u2', payload: { text: 'ok' } }));
    expect(after.some((d) => d.op === 'panel_upsert')).toBe(true);
    expect(store.panel('S')?.awaiting_input).toBe(false);
  });

  it('liveSubagentsOf filters by parent + live status', () => {
    const clock = new FakeClock();
    const store = new SessionStore({ clock: clock.now });
    store.apply(ev('user_text', { payload: { text: 'parent' } }));
    store.apply(
      ev('assistant_text', {
        uuid: 'sub1-u',
        agent_id: 'sub1',
        payload: { text: 'hi from sub' },
      }),
    );
    store.apply(
      ev('assistant_text', {
        uuid: 'sub2-u',
        agent_id: 'sub2',
        payload: { text: 'hi from sub2' },
      }),
    );
    store.forceStatus('sub2', 'done');

    const live = store.liveSubagentsOf('S');
    expect(live.map((p) => p.id)).toEqual(['sub1']);
  });

  it('remove returns panel_remove delta and deletes', () => {
    const clock = new FakeClock();
    const store = new SessionStore({ clock: clock.now });
    store.apply(ev('user_text', { payload: { text: 'hi' } }));
    expect(store.remove('S')).toEqual([{ op: 'panel_remove', panel_id: 'S' }]);
    expect(store.panel('S')).toBeUndefined();
    expect(store.remove('S')).toEqual([]);
  });

  describe('event-timestamp-driven lifecycle (bootstrap replay)', () => {
    const toIso = (epoch: number) => new Date(epoch * 1000).toISOString();

    it('uses the event ts for last_event_at (capped at clock)', () => {
      const clock = new FakeClock(10_000); // "now"
      const store = new SessionStore({ clock: clock.now });
      // Replay an old event written 2 hours ago.
      const old = { ...ev('user_text', { payload: { text: 'hi' } }), ts: toIso(10_000 - 7_200) };
      store.apply(old as Event);
      const p = store.panel('S');
      expect(p?.last_event_at).toBe(10_000 - 7_200);
      expect(p?.status_changed_at).toBe(10_000 - 7_200);
    });

    it('never projects last_event_at past the clock', () => {
      const clock = new FakeClock(10_000);
      const store = new SessionStore({ clock: clock.now });
      const future = { ...ev('user_text', { payload: { text: 'hi' } }), ts: toIso(99_999) };
      store.apply(future as Event);
      const p = store.panel('S');
      expect(p?.last_event_at).toBe(10_000);
    });

    it('falls back to clock for missing/invalid ts', () => {
      const clock = new FakeClock(10_000);
      const store = new SessionStore({ clock: clock.now });
      store.apply(ev('user_text', { payload: { text: 'hi' } }));
      expect(store.panel('S')?.last_event_at).toBe(10_000);
    });

    it('tick stamps status_changed_at at the threshold crossing, not the tick time', () => {
      const clock = new FakeClock(10_000);
      const store = new SessionStore({ clock: clock.now, idleSeconds: 60 });
      // Bootstrap replay: event was 2h ago.
      const old = { ...ev('user_text', { payload: { text: 'hi' } }), ts: toIso(10_000 - 7_200) };
      store.apply(old as Event);
      store.tick();
      const p = store.panel('S');
      expect(p?.status).toBe('done');
      // status_changed_at should be last_event_at + idleSeconds, not "now".
      expect(p?.status_changed_at).toBe(10_000 - 7_200 + 60);
    });

    it('done → mini status_changed_at also lands at the threshold crossing', () => {
      const clock = new FakeClock(10_000);
      const store = new SessionStore({
        clock: clock.now,
        idleSeconds: 60,
        miniSeconds: 300,
      });
      const old = { ...ev('user_text', { payload: { text: 'hi' } }), ts: toIso(10_000 - 7_200) };
      store.apply(old as Event);
      store.tick();
      // Now run a second tick that should chain into mini.
      store.tick();
      const p = store.panel('S');
      expect(p?.status).toBe('mini');
      // done@(t0+60), mini@(t0+60+300)
      expect(p?.status_changed_at).toBe(10_000 - 7_200 + 60 + 300);
    });
  });

  describe('resource_usage accumulation', () => {
    it('apply(resource_usage) adds to panel.tokens without pushing to events', () => {
      const clock = new FakeClock();
      const store = new SessionStore({ clock: clock.now });
      // Seed a panel first via a regular event.
      store.apply(ev('user_text', { payload: { text: 'hi' } }));
      const before = store.panel('S');
      expect(before?.tokens.input).toBe(0);
      expect(before?.events.length).toBe(1);

      store.apply(
        ev('resource_usage', {
          uuid: 'u-usage',
          payload: {
            model: 'claude-opus-4-7',
            input_tokens: 1000,
            output_tokens: 200,
            cache_creation_input_tokens: 50,
            cache_read_input_tokens: 4400,
          },
        }),
      );

      const p = store.panel('S');
      expect(p?.tokens.input).toBe(1000);
      expect(p?.tokens.output).toBe(200);
      expect(p?.tokens.cache_create).toBe(50);
      expect(p?.tokens.cache_read).toBe(4400);
      expect(p?.tokens.model).toBe('claude-opus-4-7');
      // resource_usage events are sidechanneled — not in panel.events.
      expect(p?.events.length).toBe(1);
    });

    it('multiple resource_usage events accumulate counters; last-seen model wins', () => {
      const clock = new FakeClock();
      const store = new SessionStore({ clock: clock.now });
      store.apply(ev('user_text', { payload: { text: 'hi' } }));
      store.apply(
        ev('resource_usage', {
          uuid: 'u-usage-1',
          payload: {
            model: 'claude-sonnet-4-6',
            input_tokens: 100,
            output_tokens: 20,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        }),
      );
      store.apply(
        ev('resource_usage', {
          uuid: 'u-usage-2',
          payload: {
            model: 'claude-opus-4-7',
            input_tokens: 200,
            output_tokens: 50,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        }),
      );
      const p = store.panel('S');
      expect(p?.tokens.input).toBe(300);
      expect(p?.tokens.output).toBe(70);
      expect(p?.tokens.model).toBe('claude-opus-4-7');
    });

    it('context_size tracks the latest assistant turn, not the cumulative sum', () => {
      const clock = new FakeClock();
      const store = new SessionStore({ clock: clock.now });
      store.apply(ev('user_text', { payload: { text: 'hi' } }));
      // Turn 1: 100 input + 10 cache_create + 0 cache_read = 110.
      store.apply(
        ev('resource_usage', {
          uuid: 'u-1',
          payload: {
            model: 'claude-opus-4-7',
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 10,
            cache_read_input_tokens: 0,
          },
        }),
      );
      expect(store.panel('S')?.context_size).toBe(110);
      // Turn 2: 5 input + 0 cache_create + 500 cache_read = 505.
      // Cumulative tokens would be 100+50+10+0+5+30+0+500 = 695; context_size
      // must be 505 (just turn 2), not 110+505 or 695.
      store.apply(
        ev('resource_usage', {
          uuid: 'u-2',
          payload: {
            model: 'claude-opus-4-7',
            input_tokens: 5,
            output_tokens: 30,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 500,
          },
        }),
      );
      const p = store.panel('S');
      expect(p?.context_size).toBe(505);
      // Sanity: cumulative tokens still accumulate.
      expect(p?.tokens.input).toBe(105);
      expect(p?.tokens.cache_read).toBe(500);
    });

    it('context_size surfaces on the panel_upsert DTO', () => {
      const clock = new FakeClock();
      const store = new SessionStore({ clock: clock.now });
      store.apply(ev('user_text', { payload: { text: 'hi' } }));
      const deltas = store.apply(
        ev('resource_usage', {
          uuid: 'u-1',
          payload: {
            model: 'claude-opus-4-7',
            input_tokens: 7,
            output_tokens: 1,
            cache_creation_input_tokens: 2,
            cache_read_input_tokens: 3,
          },
        }),
      );
      const upsert = deltas.find((d) => d.op === 'panel_upsert');
      if (upsert?.op === 'panel_upsert') {
        expect(upsert.panel.context_size).toBe(12);
      } else throw new Error('expected panel_upsert');
    });

    it('panel_upsert delta carries the new totals to clients', () => {
      const clock = new FakeClock();
      const store = new SessionStore({ clock: clock.now });
      store.apply(ev('user_text', { payload: { text: 'hi' } }));
      const deltas = store.apply(
        ev('resource_usage', {
          uuid: 'u-usage',
          payload: {
            model: 'claude-opus-4-7',
            input_tokens: 1,
            output_tokens: 2,
            cache_creation_input_tokens: 3,
            cache_read_input_tokens: 4,
          },
        }),
      );
      const upsert = deltas.find((d) => d.op === 'panel_upsert');
      expect(upsert).toBeDefined();
      if (upsert?.op === 'panel_upsert') {
        expect(upsert.panel.tokens.input).toBe(1);
        expect(upsert.panel.tokens.output).toBe(2);
      }
    });
  });

  describe('markEnded', () => {
    it('flips the ended flag and emits a panel_upsert', () => {
      const clock = new FakeClock();
      const store = new SessionStore({ clock: clock.now });
      store.apply(ev('user_text', { payload: { text: 'hi' } }));
      const deltas = store.markEnded('S');
      expect(store.panel('S')?.ended).toBe(true);
      expect(deltas.map((d) => d.op)).toEqual(['panel_upsert']);
    });

    it('is idempotent — second call emits nothing', () => {
      const clock = new FakeClock();
      const store = new SessionStore({ clock: clock.now });
      store.apply(ev('user_text', { payload: { text: 'hi' } }));
      store.markEnded('S');
      expect(store.markEnded('S')).toEqual([]);
    });

    it('ended is sticky — late writes do not revive the panel', () => {
      // A terminal close-out flush, a late tool_result echo, or any other
      // post-end JSONL write would previously flip `ended` back to false
      // and bounce the panel to `live`. Now the panel stays dim; the
      // event is still appended for audit but the lifecycle holds.
      const clock = new FakeClock();
      const store = new SessionStore({ clock: clock.now });
      store.apply(ev('user_text', { payload: { text: 'hi' } }));
      store.markEnded('S');
      store.forceStatus('S', 'done');
      expect(store.panel('S')?.ended).toBe(true);
      expect(store.panel('S')?.status).toBe('done');

      const deltas = store.apply(ev('assistant_text', { uuid: 'u2', payload: { text: 'late' } }));

      expect(store.panel('S')?.ended).toBe(true);
      expect(store.panel('S')?.status).toBe('done');
      // Event is appended (audit) but no status flip emitted.
      expect(deltas.some((d) => d.op === 'event_append')).toBe(true);
      expect(deltas.some((d) => d.op === 'panel_status' && d.status === 'live')).toBe(false);
    });

    it('does nothing for an unknown panel', () => {
      const store = new SessionStore({ clock: () => 0 });
      expect(store.markEnded('nope')).toEqual([]);
    });
  });

  describe('progress_complete subagent finality', () => {
    const fullList = '```brainhouse-checklist\n- [x] a\n- [x] b\n- [X] c\n```';
    const partialList = '```brainhouse-checklist\n- [x] a\n- [ ] b\n```';

    it('fires markEnded with progress_complete when a subagent checklist hits 100%', () => {
      const clock = new FakeClock();
      const store = new SessionStore({ clock: clock.now });
      // Seed the subagent panel.
      store.apply(ev('user_text', { agent_id: 'agent-x', uuid: 'u1', payload: { text: 'go' } }));
      // Ingest an assistant_text with a fully-checked checklist.
      store.apply(
        ev('assistant_text', {
          agent_id: 'agent-x',
          uuid: 'u2',
          payload: { text: `done!\n${fullList}` },
        }),
      );
      const panel = store.panel('agent-x');
      expect(panel?.ended).toBe(true);
      expect(panel?.ended_provenance).toBe('progress_complete');
    });

    it('does NOT fire on partial completion', () => {
      const clock = new FakeClock();
      const store = new SessionStore({ clock: clock.now });
      store.apply(ev('user_text', { agent_id: 'agent-x', uuid: 'u1', payload: { text: 'go' } }));
      store.apply(
        ev('assistant_text', {
          agent_id: 'agent-x',
          uuid: 'u2',
          payload: { text: partialList },
        }),
      );
      expect(store.panel('agent-x')?.ended).toBe(false);
    });

    it('does NOT fire on parent panels', () => {
      const clock = new FakeClock();
      const store = new SessionStore({ clock: clock.now });
      store.apply(
        ev('assistant_text', {
          uuid: 'u1',
          payload: { text: fullList },
        }),
      );
      expect(store.panel('S')?.ended).toBe(false);
    });

    it('persists progress_complete provenance through the Store', () => {
      const store = Store.open(':memory:');
      const sess = new SessionStore({ clock: () => 1000, store });
      sess.apply(ev('user_text', { agent_id: 'agent-x', uuid: 'u1', payload: { text: 'go' } }));
      sess.apply(
        ev('assistant_text', {
          agent_id: 'agent-x',
          uuid: 'u2',
          payload: { text: fullList },
        }),
      );
      const summary = store.getSession('agent-x');
      expect(summary?.ended_provenance).toBe('progress_complete');
      store.close();
    });
  });

  describe('Store integration', () => {
    it('apply() writes the panel + event through to the Store', () => {
      const store = Store.open(':memory:');
      const sess = new SessionStore({ clock: () => 1000, store });
      sess.apply(ev('user_text', { payload: { text: 'hi' } }));
      const row = store.getPanel('S');
      expect(row).not.toBeNull();
      expect(row?.title).toBe('hi');
      expect(store.eventsForPanel('S').length).toBe(1);
      store.close();
    });

    it('hydrate() rebuilds the in-memory panel map from the Store', () => {
      const store = Store.open(':memory:');
      const seed = new SessionStore({ clock: () => 1000, store });
      seed.apply(ev('user_text', { payload: { text: 'hi' } }));
      // Fresh SessionStore on the same DB should see the panel after hydrate.
      const restored = new SessionStore({ clock: () => 9999, store });
      restored.hydrate();
      expect(restored.panel('S')).toBeDefined();
      expect(restored.panel('S')?.title).toBe('hi');
      store.close();
    });

    it('tick live→done materializes a session_summary with idle_timeout provenance', () => {
      const store = Store.open(':memory:');
      const sess = new SessionStore({ clock: () => 1000, idleSeconds: 60, store });
      sess.apply(ev('user_text', { payload: { text: 'hi' } }));
      sess.tick(1100); // crosses idleSeconds threshold
      const summary = store.getSession('S');
      expect(summary).not.toBeNull();
      expect(summary?.ended_provenance).toBe('idle_timeout');
      store.close();
    });

    it('markEnded materializes a session_summary with the supplied provenance', () => {
      const store = Store.open(':memory:');
      const sess = new SessionStore({ clock: () => 1000, store });
      sess.apply(ev('user_text', { payload: { text: 'hi' } }));
      sess.markEnded('S', 'hook_subagent_stop');
      const summary = store.getSession('S');
      expect(summary?.ended_provenance).toBe('hook_subagent_stop');
      store.close();
    });

    it('tick mini→removed deletes the panel from the Store but keeps the summary', () => {
      const store = Store.open(':memory:');
      const sess = new SessionStore({
        clock: () => 1000,
        idleSeconds: 60,
        miniSeconds: 60,
        removeAfterSeconds: 60,
        store,
      });
      sess.apply(ev('user_text', { payload: { text: 'hi' } }));
      sess.markEnded('S', 'hook_stop');
      // Two ticks to progress live → done → mini, then one more for removal.
      sess.tick(1100); // → done
      sess.tick(1200); // → mini
      sess.tick(1300); // → removed
      expect(store.getPanel('S')).toBeNull();
      expect(store.getSession('S')).not.toBeNull();
      store.close();
    });
  });

  describe('applyAutoTitle', () => {
    it('renames the panel, appends a synthetic meta event, and emits an auto_titled delta', () => {
      const clock = new FakeClock();
      const store = new SessionStore({ clock: clock.now });
      store.apply(ev('user_text', { payload: { text: 'first prompt' } }));
      const before = store.snapshot()[0];
      expect(before?.title).toBe('first prompt');

      const deltas = store.applyAutoTitle('S', 'A much better title');
      expect(deltas.map((d) => d.op)).toEqual(['panel_upsert', 'event_append', 'auto_titled']);
      const upsert = deltas.find((d) => d.op === 'panel_upsert');
      if (upsert?.op === 'panel_upsert') {
        expect(upsert.panel.title).toBe('A much better title');
      }
      const append = deltas.find((d) => d.op === 'event_append');
      if (append?.op === 'event_append') {
        expect(append.event.kind).toBe('meta');
        if (append.event.kind === 'meta') {
          expect(append.event.payload.record_type).toBe('auto-title');
          expect(append.event.payload.raw).toEqual({
            previous: 'first prompt',
            current: 'A much better title',
          });
        }
      }
      const cue = deltas.find((d) => d.op === 'auto_titled');
      if (cue?.op === 'auto_titled') {
        expect(cue).toEqual({
          op: 'auto_titled',
          panel_id: 'S',
          prev_title: 'first prompt',
          new_title: 'A much better title',
        });
      }
      // Synthetic event is in the panel's event list, so a reload would still
      // show the breadcrumb.
      const after = store.snapshot()[0];
      expect(
        after?.events.some(
          (e) =>
            e.kind === 'meta' &&
            (e.payload as { record_type?: string }).record_type === 'auto-title',
        ),
      ).toBe(true);
    });

    it('is a no-op when the proposed title matches the current title', () => {
      const clock = new FakeClock();
      const store = new SessionStore({ clock: clock.now });
      store.apply(ev('user_text', { payload: { text: 'hi' } }));
      expect(store.applyAutoTitle('S', 'hi')).toEqual([]);
      expect(store.applyAutoTitle('S', '  hi  ')).toEqual([]); // trims before compare
    });

    it('is a no-op for unknown panel ids', () => {
      const store = new SessionStore({ clock: () => 0 });
      expect(store.applyAutoTitle('nonexistent', 'whatever')).toEqual([]);
    });

    it('is a no-op when the proposed title is empty / whitespace', () => {
      const clock = new FakeClock();
      const store = new SessionStore({ clock: clock.now });
      store.apply(ev('user_text', { payload: { text: 'hi' } }));
      expect(store.applyAutoTitle('S', '')).toEqual([]);
      expect(store.applyAutoTitle('S', '   ')).toEqual([]);
    });
  });

  describe('in-band auto-title proposals', () => {
    it('agent-emitted session-title meta retitles via the auto-title path', () => {
      const clock = new FakeClock();
      const store = new SessionStore({ clock: clock.now });
      store.apply(ev('user_text', { uuid: 'u1', payload: { text: 'first prompt' } }));
      const deltas = store.apply(
        ev('meta', {
          uuid: 'u2',
          payload: { record_type: 'session-title', raw: { title: 'now: rewriting the parser' } },
        }),
      );
      expect(deltas.some((d) => d.op === 'auto_titled')).toBe(true);
      expect(store.snapshot()[0]?.title).toBe('now: rewriting the parser');
    });

    it('later user_text events do NOT retitle on their own', () => {
      const clock = new FakeClock();
      const store = new SessionStore({ clock: clock.now });
      store.apply(ev('user_text', { uuid: 'u1', payload: { text: 'design a haiku' } }));
      store.apply(
        ev('user_text', {
          uuid: 'u2',
          payload: { text: 'oh and that should also take a param like the other two' },
        }),
      );
      expect(store.snapshot()[0]?.title).toBe('design a haiku');
    });
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
