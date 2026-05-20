import { describe, expect, it } from 'vitest';
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
    monitor.ingest(
      userTextEvent({ agent_id: 'sub1', uuid: 'u2', text: 'sub-a' }),
    );
    monitor.ingest(
      userTextEvent({ agent_id: 'sub2', uuid: 'u3', text: 'sub-b' }),
    );
    monitor.applyHookEvent({ session_id: 'S', kind: 'subagent_stop' });
    expect(monitor.store.panel('sub1')?.status).toBe('done');
    expect(monitor.store.panel('sub2')?.status).toBe('done');
    // Parent itself untouched by subagent_stop.
    expect(monitor.store.panel('S')?.status).toBe('live');
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

  it('setTimings forwards to the store and changes idle behavior', () => {
    const monitor = newMonitor();
    monitor.setTimings({ idleSeconds: 1 });
    expect(monitor.store.idleSeconds).toBe(1);
  });

  // setRoots is an integration with chokidar; not unit-testable without a
  // real watch path. Covered indirectly by the watcher tests.
});
