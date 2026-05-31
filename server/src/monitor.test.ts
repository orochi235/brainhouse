import { afterEach, describe, expect, it, vi } from 'vitest';
import { TranscriptMonitor } from './monitor.js';
import type { Event } from './parser.js';

function userTextEvent(opts: {
  session_id?: string;
  agent_id?: string | null;
  uuid?: string;
  text?: string;
  cwd?: string | null;
}): Event {
  return {
    session_id: opts.session_id ?? 'S',
    agent_id: opts.agent_id ?? null,
    uuid: opts.uuid ?? 'u1',
    parent_uuid: null,
    ts: '2026-05-19T00:00:00Z',
    cwd: opts.cwd ?? null,
    kind: 'user_text',
    payload: { text: opts.text ?? 'hi' },
  } as Event;
}

function newMonitor() {
  // Disable hook ingestion + skip the chokidar startup; we ingest directly.
  return new TranscriptMonitor({ roots: [], hookEventsDir: null });
}

describe('TranscriptMonitor', () => {
  describe('rebuildPanel safety gates', () => {
    it('returns [] when the panel does not exist', async () => {
      const monitor = newMonitor();
      const result = await monitor.rebuildPanel('does-not-exist');
      expect(result).toEqual([]);
      // No deltas emitted.
    });

    it('refuses to tear down when no JSONL can be located for the panel', async () => {
      const monitor = newMonitor();
      // Seed a panel with a cwd that points nowhere reachable from the
      // (empty) roots list — so the JSONL lookup yields nothing.
      monitor.ingest(userTextEvent({ cwd: '/nowhere/at/all' }));
      expect(monitor.store.panel('S')).toBeDefined();
      const removed: string[] = [];
      monitor.emitter.on('delta', (d) => {
        if (d.op === 'panel_remove') removed.push(d.panel_id);
      });
      const result = await monitor.rebuildPanel('S');
      expect(result).toEqual([]);
      // Panel is still in memory; no panel_remove was broadcast.
      expect(monitor.store.panel('S')).toBeDefined();
      expect(removed).toEqual([]);
    });

    it('redirects rebuild from a subagent to its owning parent', async () => {
      const monitor = newMonitor();
      // Parent + subagent, both with no resolvable JSONL — verify the
      // redirect-to-parent path without needing real files. The parent
      // lookup will then bail via the no-files gate.
      monitor.ingest(userTextEvent({ session_id: 'P', cwd: '/nope' }));
      monitor.ingest(
        userTextEvent({ session_id: 'P', agent_id: 'sub1', uuid: 'sub-u', cwd: '/nope' }),
      );
      const result = await monitor.rebuildPanel('sub1');
      // No files to re-read, but we didn't crash and the parent panel
      // is the one that was targeted (and bailed safely).
      expect(result).toEqual([]);
    });
  });

  it('ingest creates a panel and broadcasts deltas', () => {
    const monitor = newMonitor();
    const deltas: string[] = [];
    monitor.emitter.on('delta', (d) => deltas.push(d.op));
    monitor.ingest(userTextEvent({}));
    expect(deltas).toContain('panel_upsert');
    expect(deltas).toContain('event_append');
    expect(monitor.store.panel('S')?.kind).toBe('parent');
  });

  it('stamps account_label from the sourceRoot when one matches', () => {
    const monitor = new TranscriptMonitor({
      roots: [],
      hookEventsDir: null,
      accounts: [{ path: '/root/personal', label: 'personal' }],
    });
    monitor.ingest(userTextEvent({}), '/root/personal');
    expect(monitor.store.panel('S')?.account_label).toBe('personal');
  });

  it('leaves account_label null when sourceRoot is unknown', () => {
    const monitor = new TranscriptMonitor({
      roots: [],
      hookEventsDir: null,
      accounts: [{ path: '/root/personal', label: 'personal' }],
    });
    monitor.ingest(userTextEvent({}), '/root/unknown');
    expect(monitor.store.panel('S')?.account_label).toBeNull();
  });

  it('applyHookEvent stop demotes the parent to done', () => {
    const monitor = newMonitor();
    monitor.ingest(userTextEvent({}));
    expect(monitor.store.panel('S')?.status).toBe('live');
    monitor.applyHookEvent({ session_id: 'S', kind: 'stop' });
    expect(monitor.store.panel('S')?.status).toBe('done');
  });

  it('applyHookEvent notification flags awaiting_input', () => {
    const monitor = newMonitor();
    monitor.ingest(userTextEvent({}));
    monitor.applyHookEvent({ session_id: 'S', kind: 'notification' });
    expect(monitor.store.panel('S')?.awaiting_input).toBe(true);
  });

  it('applyHookEvent subagent_stop demotes all live subagents of the parent', () => {
    const monitor = newMonitor();
    monitor.ingest(userTextEvent({}));
    monitor.ingest(userTextEvent({ agent_id: 'sub1', uuid: 'u2', text: 'sub-a' }));
    monitor.ingest(userTextEvent({ agent_id: 'sub2', uuid: 'u3', text: 'sub-b' }));
    monitor.applyHookEvent({ session_id: 'S', kind: 'subagent_stop' });
    expect(monitor.store.panel('sub1')?.status).toBe('done');
    expect(monitor.store.panel('sub2')?.status).toBe('done');
    // Parent itself untouched by subagent_stop.
    expect(monitor.store.panel('S')?.status).toBe('live');
  });

  it('applyHookEvent auto_title renames the panel and broadcasts the cue delta', () => {
    const monitor = newMonitor();
    monitor.ingest(userTextEvent({}));
    const seen: string[] = [];
    monitor.emitter.on('delta', (d: { op: string }) => seen.push(d.op));
    monitor.applyHookEvent({
      session_id: 'S',
      kind: 'auto_title',
      title: 'Wire auto-titling hook',
      ts: 0,
    });
    expect(monitor.store.panel('S')?.title).toBe('Wire auto-titling hook');
    // Three deltas: panel_upsert (title), event_append (breadcrumb), auto_titled (cue).
    expect(seen).toEqual(expect.arrayContaining(['panel_upsert', 'event_append', 'auto_titled']));
  });

  it('applyHookEvent auto_title with empty title is a no-op', () => {
    const monitor = newMonitor();
    monitor.ingest(userTextEvent({}));
    const before = monitor.store.panel('S')?.title;
    monitor.applyHookEvent({ session_id: 'S', kind: 'auto_title', title: '   ', ts: 0 });
    expect(monitor.store.panel('S')?.title).toBe(before);
  });

  it('applyHookEvent hook_overhead accumulates onto the panel counter', () => {
    const monitor = newMonitor();
    monitor.ingest(userTextEvent({}));
    expect(monitor.store.panel('S')?.hook_overhead_tokens).toBe(0);
    monitor.applyHookEvent({
      session_id: 'S',
      kind: 'hook_overhead',
      hook_name: 'context-reminder',
      tokens: 70,
      ts: 0,
    });
    monitor.applyHookEvent({
      session_id: 'S',
      kind: 'hook_overhead',
      hook_name: 'handoff-resume',
      tokens: 120,
      ts: 0,
    });
    expect(monitor.store.panel('S')?.hook_overhead_tokens).toBe(190);
  });

  it('applyHookEvent hook_overhead with zero / missing tokens is a no-op', () => {
    const monitor = newMonitor();
    monitor.ingest(userTextEvent({}));
    monitor.applyHookEvent({ session_id: 'S', kind: 'hook_overhead', ts: 0 });
    monitor.applyHookEvent({ session_id: 'S', kind: 'hook_overhead', tokens: 0, ts: 0 });
    expect(monitor.store.panel('S')?.hook_overhead_tokens).toBe(0);
  });

  it('subagent_stop also marks each subagent as ended', () => {
    const monitor = newMonitor();
    monitor.ingest(userTextEvent({}));
    monitor.ingest(userTextEvent({ agent_id: 'sub1', uuid: 'u2' }));
    monitor.applyHookEvent({ session_id: 'S', kind: 'subagent_stop' });
    expect(monitor.store.panel('sub1')?.ended).toBe(true);
    // Parent is never marked ended on subagent_stop.
    expect(monitor.store.panel('S')?.ended).toBe(false);
  });

  it('Stop hook materializes a session_summary with hook_stop provenance', async () => {
    const { Store } = await import('./store.js');
    const store = Store.open(':memory:');
    const monitor = new TranscriptMonitor({ roots: [], hookEventsDir: null, store });
    monitor.ingest(userTextEvent({}));
    monitor.applyHookEvent({ session_id: 'S', kind: 'stop' });
    expect(store.getSession('S')?.ended_provenance).toBe('hook_stop');
    // But ended flag stays false — parent might prompt again.
    expect(monitor.store.panel('S')?.ended).toBe(false);
    store.close();
  });

  it('plain Stop on the parent does NOT mark it ended (only idle)', () => {
    const monitor = newMonitor();
    monitor.ingest(userTextEvent({}));
    monitor.applyHookEvent({ session_id: 'S', kind: 'stop' });
    expect(monitor.store.panel('S')?.status).toBe('done');
    expect(monitor.store.panel('S')?.ended).toBe(false);
  });

  it('SessionEnd hook marks the parent ended + demotes live subagents', () => {
    const monitor = newMonitor();
    monitor.ingest(userTextEvent({}));
    monitor.ingest(userTextEvent({ agent_id: 'sub1', uuid: 'u2' }));
    monitor.ingest(userTextEvent({ agent_id: 'sub2', uuid: 'u3' }));
    monitor.applyHookEvent({ session_id: 'S', kind: 'session_end' });
    expect(monitor.store.panel('S')?.status).toBe('done');
    expect(monitor.store.panel('S')?.ended).toBe(true);
    expect(monitor.store.panel('S')?.ended_provenance).toBe('hook_session_end');
    expect(monitor.store.panel('sub1')?.ended).toBe(true);
    expect(monitor.store.panel('sub2')?.ended).toBe(true);
  });

  describe('SessionStart supersede', () => {
    const PROJECTS = '/Users/x/.claude/projects';
    const CWD = '/Users/x/work/foo';
    const ENCODED_DIR = '-Users-x-work-foo';
    const oldTranscript = `${PROJECTS}/${ENCODED_DIR}/OLD.jsonl`;
    const newTranscript = `${PROJECTS}/${ENCODED_DIR}/NEW.jsonl`;
    const recentTs = Date.now() / 1000;
    // Seed OLD's activity 10 seconds before the new SessionStart hook ts —
    // inside the 5-minute recency window, but old enough to clear the
    // SUPERSEDE_MIN_IDLE_SECONDS floor (which protects actively-responding
    // sessions in other terminals from being wrongly superseded).
    const oldActivityTs = recentTs - 10;
    const oldActivityIso = new Date(oldActivityTs * 1000).toISOString();

    function seedOld(monitor: TranscriptMonitor): void {
      monitor.ingest({
        ...userTextEvent({ session_id: 'OLD', uuid: 'u1', cwd: CWD }),
        ts: oldActivityIso,
      } as Event);
    }

    it('source=clear ends the prior live panel in the same project dir', () => {
      const monitor = newMonitor();
      seedOld(monitor);
      monitor.applyHookEvent({
        session_id: 'NEW',
        kind: 'session_start',
        source: 'clear',
        transcript_path: newTranscript,
        ts: recentTs,
      });
      const old = monitor.store.panel('OLD');
      expect(old?.ended).toBe(true);
      expect(old?.ended_provenance).toBe('hook_session_start_supersede');
      expect(old?.status).toBe('done');
    });

    it('source=compact also supersedes', () => {
      const monitor = newMonitor();
      seedOld(monitor);
      monitor.applyHookEvent({
        session_id: 'NEW',
        kind: 'session_start',
        source: 'compact',
        transcript_path: newTranscript,
        ts: recentTs,
      });
      expect(monitor.store.panel('OLD')?.ended).toBe(true);
    });

    it('source=startup does NOT supersede', () => {
      const monitor = newMonitor();
      seedOld(monitor);
      monitor.applyHookEvent({
        session_id: 'NEW',
        kind: 'session_start',
        source: 'startup',
        transcript_path: newTranscript,
        ts: recentTs,
      });
      expect(monitor.store.panel('OLD')?.ended).toBe(false);
    });

    it('source=resume does NOT supersede', () => {
      const monitor = newMonitor();
      seedOld(monitor);
      monitor.applyHookEvent({
        session_id: 'NEW',
        kind: 'session_start',
        source: 'resume',
        transcript_path: newTranscript,
        ts: recentTs,
      });
      expect(monitor.store.panel('OLD')?.ended).toBe(false);
    });

    it('skips panels in a different project dir', () => {
      const monitor = newMonitor();
      monitor.ingest({
        ...userTextEvent({ session_id: 'OLD', uuid: 'u1', cwd: '/Users/x/work/other' }),
        ts: oldActivityIso,
      } as Event);
      monitor.applyHookEvent({
        session_id: 'NEW',
        kind: 'session_start',
        source: 'clear',
        transcript_path: newTranscript,
        ts: recentTs,
      });
      expect(monitor.store.panel('OLD')?.ended).toBe(false);
    });

    it('skips panels whose last activity is outside the recency window', () => {
      const monitor = newMonitor();
      seedOld(monitor);
      monitor.applyHookEvent({
        session_id: 'NEW',
        kind: 'session_start',
        source: 'clear',
        transcript_path: newTranscript,
        // 1 hour ahead → seeded panel's last_event_at is far older than the
        // 5-minute window, so no supersession.
        ts: recentTs + 3600,
      });
      expect(monitor.store.panel('OLD')?.ended).toBe(false);
    });

    it('skips panels whose last activity is too recent (actively responding)', () => {
      // Regression: a /clear in another terminal in the same cwd was wrongly
      // ending the actively-responding session that just emitted an event
      // moments before the new SessionStart. The min-idle filter protects
      // panels whose last_event_at is within SUPERSEDE_MIN_IDLE_SECONDS of
      // `now` — they're mid-response, not the "prior session" being cleared.
      const monitor = newMonitor();
      const veryRecentIso = new Date((recentTs - 0.1) * 1000).toISOString();
      monitor.ingest({
        ...userTextEvent({ session_id: 'OLD', uuid: 'u1', cwd: CWD }),
        ts: veryRecentIso,
      } as Event);
      monitor.applyHookEvent({
        session_id: 'NEW',
        kind: 'session_start',
        source: 'clear',
        transcript_path: newTranscript,
        ts: recentTs,
      });
      expect(monitor.store.panel('OLD')?.ended).toBe(false);
    });

    it('does not end already-ended panels', () => {
      const monitor = newMonitor();
      seedOld(monitor);
      monitor.applyHookEvent({ session_id: 'OLD', kind: 'session_end', ts: recentTs });
      expect(monitor.store.panel('OLD')?.ended_provenance).toBe('hook_session_end');
      monitor.applyHookEvent({
        session_id: 'NEW',
        kind: 'session_start',
        source: 'clear',
        transcript_path: newTranscript,
        ts: recentTs,
      });
      // Provenance from the first authoritative end is preserved.
      expect(monitor.store.panel('OLD')?.ended_provenance).toBe('hook_session_end');
    });

    it('demotes live subagents under the superseded parent', () => {
      const monitor = newMonitor();
      seedOld(monitor);
      monitor.ingest({
        ...userTextEvent({ session_id: 'OLD', agent_id: 'sub1', uuid: 'u2', cwd: CWD }),
        ts: oldActivityIso,
      } as Event);
      monitor.applyHookEvent({
        session_id: 'NEW',
        kind: 'session_start',
        source: 'clear',
        transcript_path: newTranscript,
        ts: recentTs,
      });
      expect(monitor.store.panel('sub1')?.ended).toBe(true);
      expect(monitor.store.panel('sub1')?.ended_provenance).toBe('hook_session_start_supersede');
    });

    describe('5s mini transition after supersede', () => {
      afterEach(() => {
        vi.useRealTimers();
      });

      it('forces the superseded parent to mini 5 seconds later', async () => {
        vi.useFakeTimers();
        const monitor = newMonitor();
        seedOld(monitor);
        monitor.applyHookEvent({
          session_id: 'NEW',
          kind: 'session_start',
          source: 'clear',
          transcript_path: newTranscript,
          ts: recentTs,
        });
        expect(monitor.store.panel('OLD')?.status).toBe('done');
        await vi.advanceTimersByTimeAsync(5_000);
        expect(monitor.store.panel('OLD')?.status).toBe('mini');
      });

      it('also forces demoted subagents to mini', async () => {
        vi.useFakeTimers();
        const monitor = newMonitor();
        seedOld(monitor);
        monitor.ingest({
          ...userTextEvent({ session_id: 'OLD', agent_id: 'sub1', uuid: 'u2', cwd: CWD }),
          ts: oldActivityIso,
        } as Event);
        monitor.applyHookEvent({
          session_id: 'NEW',
          kind: 'session_start',
          source: 'clear',
          transcript_path: newTranscript,
          ts: recentTs,
        });
        await vi.advanceTimersByTimeAsync(5_000);
        expect(monitor.store.panel('sub1')?.status).toBe('mini');
      });

      it('skips the mini transition when the panel is pinned', async () => {
        vi.useFakeTimers();
        const { Store } = await import('./store.js');
        const store = Store.open(':memory:');
        const monitor = new TranscriptMonitor({ roots: [], hookEventsDir: null, store });
        seedOld(monitor);
        store.upsertIntentions({
          panel_id: 'OLD',
          pinned: true,
          wide: false,
          manual_order: null,
          user_mini: false,
          hidden_at: null,
          auto_mini_at: null,
          broken_out: false,
          user_kept: false,
          updated_at: recentTs,
        });
        monitor.applyHookEvent({
          session_id: 'NEW',
          kind: 'session_start',
          source: 'clear',
          transcript_path: newTranscript,
          ts: recentTs,
        });
        // Pinned panels still dim (markEnded runs immediately) but never
        // auto-minimize on supersede.
        expect(monitor.store.panel('OLD')?.ended).toBe(true);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(monitor.store.panel('OLD')?.status).toBe('done');
        store.close();
      });

    });

    it('picks the most recently active panel when multiple match', () => {
      const monitor = newMonitor();
      // Two panels in the same cwd; OLDER seeded first with an earlier ts.
      monitor.ingest({
        ...userTextEvent({ session_id: 'OLDER', uuid: 'a', cwd: CWD }),
        ts: '2026-05-19T00:00:00Z',
      } as Event);
      monitor.ingest({
        ...userTextEvent({ session_id: 'NEWER', uuid: 'b', cwd: CWD }),
        ts: '2026-05-19T00:00:30Z',
      } as Event);
      monitor.applyHookEvent({
        session_id: 'NEW',
        kind: 'session_start',
        source: 'clear',
        transcript_path: newTranscript,
        // Far enough ahead to keep both inside the 5-min window.
        ts: Date.parse('2026-05-19T00:02:00Z') / 1000,
      });
      expect(monitor.store.panel('NEWER')?.ended).toBe(true);
      expect(monitor.store.panel('OLDER')?.ended).toBe(false);
    });
  });

  it('setTimings forwards to the store and changes idle behavior', () => {
    const monitor = newMonitor();
    monitor.setTimings({ idleSeconds: 1 });
    expect(monitor.store.idleSeconds).toBe(1);
  });

  it('start() prunes events_index rows older than the retention window', async () => {
    const { Store } = await import('./store.js');
    const store = Store.open(':memory:');
    // Pre-seed an old row + a fresh row.
    const now = Date.now() / 1000;
    store.recordEvent({
      panel_id: 'S',
      event_uuid: 'old',
      ts: now - 60 * 86_400, // 60 days ago
      kind: 'user_text',
      tool_name: null,
      file_path: null,
      summary: null,
    });
    store.recordEvent({
      panel_id: 'S',
      event_uuid: 'new',
      ts: now - 1, // 1 second ago
      kind: 'user_text',
      tool_name: null,
      file_path: null,
      summary: null,
    });
    const monitor = new TranscriptMonitor({
      roots: [],
      hookEventsDir: null,
      store,
      eventsIndexRetentionDays: 30,
    });
    await monitor.start({ watch: false });
    await monitor.stop();
    const remaining = store.eventsForPanel('S');
    expect(remaining.map((e) => e.event_uuid)).toEqual(['new']);
    store.close();
  });

  it('setEventsIndexRetentionDays takes effect immediately', async () => {
    const { Store } = await import('./store.js');
    const store = Store.open(':memory:');
    const now = Date.now() / 1000;
    // Two rows: one 10 days old, one 1 day old.
    store.recordEvent({
      panel_id: 'S',
      event_uuid: 'ten',
      ts: now - 10 * 86_400,
      kind: 'user_text',
      tool_name: null,
      file_path: null,
      summary: null,
    });
    store.recordEvent({
      panel_id: 'S',
      event_uuid: 'one',
      ts: now - 86_400,
      kind: 'user_text',
      tool_name: null,
      file_path: null,
      summary: null,
    });
    const monitor = new TranscriptMonitor({
      roots: [],
      hookEventsDir: null,
      store,
      eventsIndexRetentionDays: 30, // both kept initially
    });
    await monitor.start({ watch: false });
    expect(store.eventsForPanel('S').length).toBe(2);
    // Tighten the window — only the 1-day-old row survives.
    monitor.setEventsIndexRetentionDays(5);
    expect(store.eventsForPanel('S').map((e) => e.event_uuid)).toEqual(['one']);
    await monitor.stop();
    store.close();
  });

  // setRoots is an integration with chokidar; not unit-testable without a
  // real watch path. Covered indirectly by the watcher tests.
});
