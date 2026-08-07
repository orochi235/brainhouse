/**
 * Unit tests for the AlertQueue. Pure-logic: fake timers drive the grace
 * window; panels are plain objects mutated in place to simulate waits
 * clearing.
 */
import { describe, expect, it } from 'vitest';
import { AlertQueue } from './alertQueue.js';
import type { Panel } from './session.js';

function makePanel(overrides: Partial<Panel> = {}): Panel {
  return {
    id: 'panel-abc12345',
    kind: 'parent',
    parent_panel_id: null,
    title: 'panel-ab',
    agent_type: null,
    task_description: null,
    account_label: null,
    binned_at: null,
    awaiting_input: false,
    ended: false,
    ended_provenance: null,
    manually_renamed: false,
    tokens: { input: 0, output: 0, cache_create: 0, cache_read: 0, model: null },
    context_size: 0,
    hook_overhead_tokens: 0,
    clear_title_suppression: null,
    status: 'live',
    started_at: 0,
    last_event_at: 0,
    status_changed_at: 0,
    cwd: null,
    repo_root: null,
    iterm_session_id: null,
    theme: null,
    events: [],
    ...overrides,
  } as Panel;
}

class FakeTimers {
  private nextId = 1;
  private readonly pending = new Map<number, { fire: number; fn: () => void }>();
  t = 1_000_000;
  now = () => this.t;
  setTimer = (fn: () => void, ms: number) => {
    const id = this.nextId++;
    this.pending.set(id, { fire: this.t + ms, fn });
    return id;
  };
  clearTimer = (h: unknown) => {
    this.pending.delete(h as number);
  };
  advance(dt: number) {
    this.t += dt;
    let drained = false;
    while (!drained) {
      drained = true;
      for (const [id, entry] of [...this.pending]) {
        if (entry.fire <= this.t) {
          this.pending.delete(id);
          entry.fn();
          drained = false;
        }
      }
    }
  }
}

function defaultPrefs() {
  return { muteAll: false, macNative: true, macNativeTurnComplete: false, graceSeconds: 30 };
}

function build(opts: {
  panels: Map<string, Panel>;
  prefs?: () => ReturnType<typeof defaultPrefs>;
  timers: FakeTimers;
}) {
  return new AlertQueue({
    getPanel: (id) => opts.panels.get(id),
    getNotificationPrefs: opts.prefs ?? defaultPrefs,
    now: opts.timers.now,
    setTimer: opts.timers.setTimer,
    clearTimer: opts.timers.clearTimer,
  });
}

describe('AlertQueue', () => {
  it('enqueues after the grace window when still awaiting', () => {
    const timers = new FakeTimers();
    const panel = makePanel({ awaiting_input: true, title: 'T', iterm_session_id: 'GUID-1' });
    const q = build({ panels: new Map([[panel.id, panel]]), timers });
    q.onAwaiting(panel.id, true);
    expect(q.list(-1)).toHaveLength(0);
    timers.advance(30_000);
    const alerts = q.list(-1);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      panel_id: panel.id,
      reason: 'awaiting',
      iterm_session_id: 'GUID-1',
    });
  });

  it('never fires when the wait clears inside the grace window', () => {
    const timers = new FakeTimers();
    const panel = makePanel({ awaiting_input: true });
    const q = build({ panels: new Map([[panel.id, panel]]), timers });
    q.onAwaiting(panel.id, true);
    panel.awaiting_input = false; // answered
    timers.advance(30_000);
    expect(q.list(-1)).toHaveLength(0);
  });

  it('graceSeconds 0 enqueues immediately', () => {
    const timers = new FakeTimers();
    const panel = makePanel({ awaiting_input: true });
    const q = build({
      panels: new Map([[panel.id, panel]]),
      prefs: () => ({ ...defaultPrefs(), graceSeconds: 0 }),
      timers,
    });
    q.onAwaiting(panel.id, true);
    expect(q.list(-1)).toHaveLength(1);
  });

  it('dedupes within one wait episode, re-alerts on a new episode', () => {
    const timers = new FakeTimers();
    const panel = makePanel({ awaiting_input: true });
    const q = build({ panels: new Map([[panel.id, panel]]), timers });
    q.onAwaiting(panel.id, true);
    q.onAwaiting(panel.id, true); // duplicate transition
    timers.advance(30_000);
    expect(q.list(-1)).toHaveLength(1);
    // Episode ends (clearing drops the undelivered alert), new one begins:
    // a fresh alert fires — dedupe state didn't linger across episodes.
    panel.awaiting_input = false;
    q.onAwaiting(panel.id, false);
    panel.awaiting_input = true;
    q.onAwaiting(panel.id, true);
    timers.advance(30_000);
    expect(q.list(-1)).toMatchObject([{ id: 2, reason: 'awaiting' }]);
  });

  it('clearing the wait drops an undelivered queued alert', () => {
    const timers = new FakeTimers();
    const panel = makePanel({ awaiting_input: true });
    const q = build({ panels: new Map([[panel.id, panel]]), timers });
    q.onAwaiting(panel.id, true);
    timers.advance(30_000);
    expect(q.list(-1)).toHaveLength(1);
    panel.awaiting_input = false;
    q.onAwaiting(panel.id, false);
    expect(q.list(-1)).toHaveLength(0);
  });

  it('list prunes awaiting alerts whose panel stopped awaiting (read-time)', () => {
    const timers = new FakeTimers();
    const panel = makePanel({ awaiting_input: true });
    const q = build({ panels: new Map([[panel.id, panel]]), timers });
    q.onAwaiting(panel.id, true);
    timers.advance(30_000);
    panel.awaiting_input = false; // cleared via transcript activity, no onAwaiting(false)
    expect(q.list(-1)).toHaveLength(0);
  });

  it('turn_complete fires immediately when the pref is on, never when off', () => {
    const timers = new FakeTimers();
    const panel = makePanel({});
    const panels = new Map([[panel.id, panel]]);
    const off = build({ panels, timers });
    off.onStop(panel.id);
    expect(off.list(-1)).toHaveLength(0);
    const on = build({
      panels,
      prefs: () => ({ ...defaultPrefs(), macNativeTurnComplete: true }),
      timers,
    });
    on.onStop(panel.id);
    expect(on.list(-1)).toMatchObject([{ reason: 'turn_complete' }]);
  });

  it('muteAll and macNative-off suppress enqueue', () => {
    const timers = new FakeTimers();
    const panel = makePanel({ awaiting_input: true });
    const panels = new Map([[panel.id, panel]]);
    for (const prefs of [
      () => ({ ...defaultPrefs(), muteAll: true }),
      () => ({ ...defaultPrefs(), macNative: false }),
    ]) {
      const q = build({ panels, prefs, timers });
      q.onAwaiting(panel.id, true);
      timers.advance(30_000);
      expect(q.list(-1)).toHaveLength(0);
    }
  });

  it('cursor pagination: list(after) returns only newer ids', () => {
    const timers = new FakeTimers();
    const p1 = makePanel({ id: 'p1', awaiting_input: true });
    const p2 = makePanel({ id: 'p2', awaiting_input: true });
    const q = build({
      panels: new Map([
        [p1.id, p1],
        [p2.id, p2],
      ]),
      prefs: () => ({ ...defaultPrefs(), graceSeconds: 0 }),
      timers,
    });
    q.onAwaiting(p1.id, true);
    const first = q.list(-1);
    expect(first).toHaveLength(1);
    q.onAwaiting(p2.id, true);
    const newer = q.list(first[0]?.id ?? -1);
    expect(newer).toHaveLength(1);
    expect(newer[0]?.panel_id).toBe('p2');
  });

  it('alerts expire after 10 minutes', () => {
    const timers = new FakeTimers();
    const panel = makePanel({ awaiting_input: true });
    const q = build({
      panels: new Map([[panel.id, panel]]),
      prefs: () => ({ ...defaultPrefs(), graceSeconds: 0 }),
      timers,
    });
    q.onAwaiting(panel.id, true);
    timers.advance(10 * 60_000 + 1_000);
    expect(q.list(-1)).toHaveLength(0);
  });

  it('project falls back to cwd basename when repo_root is null', () => {
    const timers = new FakeTimers();
    const panel = makePanel({
      awaiting_input: true,
      repo_root: null,
      cwd: '/Users/x/src/myproj',
    });
    const q = build({
      panels: new Map([[panel.id, panel]]),
      prefs: () => ({ ...defaultPrefs(), graceSeconds: 0 }),
      timers,
    });
    q.onAwaiting(panel.id, true);
    expect(q.list(-1)[0]?.project).toBe('myproj');
  });

  it('dispose clears pending timers and queued alerts for the panel', () => {
    const timers = new FakeTimers();
    const panel = makePanel({ awaiting_input: true });
    const q = build({ panels: new Map([[panel.id, panel]]), timers });
    q.onAwaiting(panel.id, true);
    q.dispose(panel.id);
    timers.advance(30_000);
    expect(q.list(-1)).toHaveLength(0);
  });
});
