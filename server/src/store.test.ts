import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type EventIndexRow,
  type IntentionsRow,
  type PanelRow,
  type SessionSummaryRow,
  Store,
} from './store.js';

let store: Store;

beforeEach(() => {
  store = Store.open(':memory:');
});

afterEach(() => {
  store.close();
});

function intentions(overrides: Partial<IntentionsRow> = {}): IntentionsRow {
  return {
    panel_id: 'p1',
    pinned: false,
    wide: false,
    manual_order: null,
    user_mini: false,
    hidden_at: null,
    auto_mini_at: null,
    broken_out: false,
    updated_at: 1_000,
    ...overrides,
  };
}

function panel(overrides: Partial<PanelRow> = {}): PanelRow {
  return {
    id: 'p1',
    kind: 'parent',
    parent_panel_id: null,
    title: 'a session',
    agent_type: null,
    account_label: null,
    status: 'live',
    started_at: 0,
    last_event_at: 100,
    status_changed_at: 0,
    cwd: '/tmp/foo',
    theme_bg: null,
    theme_fg: null,
    binned_at: null,
    awaiting_input: false,
    ended: false,
    ended_provenance: null,
    updated_at: 100,
    ...overrides,
  };
}

function summary(overrides: Partial<SessionSummaryRow> = {}): SessionSummaryRow {
  return {
    session_id: 's1',
    kind: 'parent',
    parent_session_id: null,
    account_label: null,
    title: 'a session',
    agent_type: null,
    cwd: '/tmp/foo',
    started_at: 0,
    ended_at: 100,
    duration_active_s: 90,
    ended_provenance: 'idle_timeout',
    event_count: 5,
    tool_call_count: 2,
    error_count: 0,
    unique_files_touched: 1,
    tool_mix_json: JSON.stringify({ Bash: 2 }),
    key_files_json: JSON.stringify(['/tmp/foo/x.ts']),
    key_decisions: null,
    open_threads_json: null,
    pinned_checklist_json: null,
    rolled_up_at: 100,
    ...overrides,
  };
}

describe('Store', () => {
  it('opens an in-memory db and writes the schema_version', () => {
    // No throw means the schema applied.
    expect(store.allPanels()).toEqual([]);
    expect(store.allIntentions()).toEqual([]);
  });

  describe('intentions', () => {
    it('upsert + get round-trips booleans correctly', () => {
      store.upsertIntentions(intentions({ pinned: true, wide: true, user_mini: true }));
      const got = store.getIntentions('p1');
      expect(got).not.toBeNull();
      expect(got?.pinned).toBe(true);
      expect(got?.wide).toBe(true);
      expect(got?.user_mini).toBe(true);
    });

    it('upsert is idempotent on conflict', () => {
      store.upsertIntentions(intentions({ pinned: true }));
      store.upsertIntentions(intentions({ pinned: false, wide: true }));
      const got = store.getIntentions('p1');
      expect(got?.pinned).toBe(false);
      expect(got?.wide).toBe(true);
    });

    it('delete removes the row', () => {
      store.upsertIntentions(intentions());
      store.deleteIntentions('p1');
      expect(store.getIntentions('p1')).toBeNull();
    });

    it('allIntentions returns every row', () => {
      store.upsertIntentions(intentions({ panel_id: 'p1' }));
      store.upsertIntentions(intentions({ panel_id: 'p2', pinned: true }));
      expect(store.allIntentions().length).toBe(2);
    });
  });

  describe('panels', () => {
    it('upsert + get preserves all fields', () => {
      const p = panel({ ended: true, ended_provenance: 'hook_subagent_stop' });
      store.upsertPanel(p);
      const got = store.getPanel('p1');
      expect(got).toEqual(p);
    });

    it('upsert updates an existing row', () => {
      store.upsertPanel(panel());
      store.upsertPanel(panel({ status: 'done', last_event_at: 200 }));
      const got = store.getPanel('p1');
      expect(got?.status).toBe('done');
      expect(got?.last_event_at).toBe(200);
    });

    it('delete drops the panel', () => {
      store.upsertPanel(panel());
      store.deletePanel('p1');
      expect(store.getPanel('p1')).toBeNull();
    });
  });

  describe('events_index', () => {
    function event(overrides: Partial<EventIndexRow> = {}): EventIndexRow {
      return {
        panel_id: 'p1',
        event_uuid: 'u1',
        ts: 100,
        kind: 'assistant_text',
        tool_name: null,
        file_path: null,
        summary: null,
        ...overrides,
      };
    }

    it('records events idempotently (PRIMARY KEY conflict ignored)', () => {
      store.recordEvent(event());
      store.recordEvent(event()); // duplicate
      expect(store.eventsForPanel('p1').length).toBe(1);
    });

    it('orders events by ts when listing for a panel', () => {
      store.recordEvent(event({ event_uuid: 'u1', ts: 200 }));
      store.recordEvent(event({ event_uuid: 'u2', ts: 100 }));
      store.recordEvent(event({ event_uuid: 'u3', ts: 300 }));
      const events = store.eventsForPanel('p1');
      expect(events.map((e) => e.event_uuid)).toEqual(['u2', 'u1', 'u3']);
    });

    it('eventsTouchingFile filters by file_path', () => {
      store.recordEvent(event({ event_uuid: 'u1', tool_name: 'Read', file_path: '/a.ts' }));
      store.recordEvent(event({ event_uuid: 'u2', tool_name: 'Read', file_path: '/b.ts' }));
      store.recordEvent(event({ event_uuid: 'u3', tool_name: 'Edit', file_path: '/a.ts' }));
      const events = store.eventsTouchingFile('/a.ts');
      expect(events.length).toBe(2);
      expect(events.every((e) => e.file_path === '/a.ts')).toBe(true);
    });

    it('pruneEventsBefore drops rows older than the cutoff', () => {
      store.recordEvent(event({ event_uuid: 'u1', ts: 50 }));
      store.recordEvent(event({ event_uuid: 'u2', ts: 150 }));
      store.recordEvent(event({ event_uuid: 'u3', ts: 250 }));
      expect(store.pruneEventsBefore(150)).toBe(1);
      expect(store.eventsForPanel('p1').map((e) => e.event_uuid)).toEqual(['u2', 'u3']);
    });
  });

  describe('session_summary', () => {
    it('materializeSession + getSession round-trip', () => {
      const row = summary({ key_decisions: 'we landed feature X' });
      store.materializeSession(row);
      expect(store.getSession('s1')).toEqual(row);
    });

    it('re-materializing the same session_id overwrites prior fields', () => {
      store.materializeSession(summary({ event_count: 5 }));
      store.materializeSession(summary({ event_count: 12, ended_provenance: 'hook_stop' }));
      const got = store.getSession('s1');
      expect(got?.event_count).toBe(12);
      expect(got?.ended_provenance).toBe('hook_stop');
    });

    it('sessionsForProject filters + orders by started_at DESC', () => {
      store.materializeSession(summary({ session_id: 's1', cwd: '/a', started_at: 100 }));
      store.materializeSession(summary({ session_id: 's2', cwd: '/a', started_at: 300 }));
      store.materializeSession(summary({ session_id: 's3', cwd: '/b', started_at: 200 }));
      const rows = store.sessionsForProject('/a');
      expect(rows.map((r) => r.session_id)).toEqual(['s2', 's1']);
    });
  });

  describe('bootstrap_offsets', () => {
    it('get returns null for an unknown file', () => {
      expect(store.getBootstrapOffset('/x.jsonl')).toBeNull();
    });

    it('set then get round-trips the offset', () => {
      store.setBootstrapOffset('/x.jsonl', 1234, 999);
      expect(store.getBootstrapOffset('/x.jsonl')).toBe(1234);
    });

    it('set updates the offset on subsequent calls', () => {
      store.setBootstrapOffset('/x.jsonl', 100);
      store.setBootstrapOffset('/x.jsonl', 500);
      expect(store.getBootstrapOffset('/x.jsonl')).toBe(500);
    });
  });
});
