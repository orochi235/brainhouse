import { mkdtempSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TranscriptMonitor } from './monitor.js';
import { PrefsStore } from './prefs.js';
import { appRouter } from './trpc.js';

describe('appRouter', () => {
  let dir: string;
  let monitor: TranscriptMonitor;
  let prefs: PrefsStore;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'brainhouse-router-'));
    monitor = new TranscriptMonitor({ roots: [dir], tickIntervalMs: 100 });
    await monitor.start({ watch: false });
    prefs = new PrefsStore(path.join(dir, 'prefs.json'));
    await prefs.load();
  });

  afterEach(async () => {
    await monitor.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it('health returns ok', async () => {
    const caller = appRouter.createCaller({ monitor, prefs });
    const result = await caller.health();
    expect(result.ok).toBe(true);
    expect(result.name).toBe('brainhouse');
  });

  it('snapshot starts empty and reflects ingested events', async () => {
    const caller = appRouter.createCaller({ monitor, prefs });
    expect((await caller.snapshot()).panels).toEqual([]);

    monitor.ingest({
      session_id: 'S',
      agent_id: null,
      uuid: 'u1',
      parent_uuid: null,
      ts: 't',
      cwd: null,
      kind: 'user_text',
      payload: { text: 'hello' },
    });

    const snap = await caller.snapshot();
    expect(snap.panels).toHaveLength(1);
    expect(snap.panels[0]?.id).toBe('S');
  });

  it('forceStatus mutates panel state', async () => {
    const caller = appRouter.createCaller({ monitor, prefs });
    monitor.ingest({
      session_id: 'S',
      agent_id: null,
      uuid: 'u1',
      parent_uuid: null,
      cwd: null,
      ts: 't',
      kind: 'user_text',
      payload: { text: 'hi' },
    });
    const res = await caller.forceStatus({ panelId: 'S', status: 'done' });
    expect(res.ok).toBe(true);
    expect(monitor.store.panel('S')?.status).toBe('done');
  });

  it('remove soft-deletes (bin), bin.restore round-trips, bin.purge hard-deletes', async () => {
    const caller = appRouter.createCaller({ monitor, prefs });
    monitor.ingest({
      session_id: 'S',
      agent_id: null,
      uuid: 'u1',
      parent_uuid: null,
      cwd: null,
      ts: 't',
      kind: 'user_text',
      payload: { text: 'hi' },
    });
    expect(monitor.store.panel('S')).toBeDefined();

    // remove → soft delete: panel stays but is binned + hidden from snapshot.
    await caller.remove({ panelId: 'S' });
    expect(monitor.store.panel('S')).toBeDefined();
    expect(monitor.store.panel('S')?.binned_at).not.toBeNull();
    expect(monitor.store.snapshot()).toHaveLength(0);
    const bin1 = await caller.bin.list();
    expect(bin1.panels).toHaveLength(1);

    // bin.restore → un-bin.
    await caller.bin.restore({ panelId: 'S' });
    expect(monitor.store.panel('S')?.binned_at).toBeNull();
    expect(monitor.store.snapshot()).toHaveLength(1);

    // bin again, then bin.purge → hard delete.
    await caller.remove({ panelId: 'S' });
    await caller.bin.purge({ panelId: 'S' });
    expect(monitor.store.panel('S')).toBeUndefined();
  });
});

describe('panelHistory', () => {
  it('returns older events parsed from the panel JSONL', async () => {
    // String-content assistant lines → one assistant_text event each, with
    // the bare record uuid (no content-block `:i` suffix).
    const line = (uuid: string, text: string) =>
      JSON.stringify({
        type: 'assistant',
        uuid,
        timestamp: '2026-01-01T00:00:00Z',
        message: { content: text },
      });
    const dir = mkdtempSync(join(tmpdir(), 'bh-hist-'));
    const file = join(dir, 'S.jsonl');
    writeFileSync(file, [line('u1', 'one'), line('u2', 'two'), line('u3', 'three')].join('\n'));

    const monitor = { sourceFileForPanel: (id: string) => (id === 'S' ? file : null) } as never;
    const prefs = { get: () => ({}) } as never;
    const caller = appRouter.createCaller({ monitor, prefs });

    const res = await caller.panelHistory({ panelId: 'S', beforeUuid: 'u3', limit: 10 });
    expect(res.events.map((e) => e.uuid)).toEqual(['u1', 'u2']);
    expect(res.hasMore).toBe(false);
  });

  it('returns empty when the panel has no resolvable file', async () => {
    const monitor = { sourceFileForPanel: () => null } as never;
    const prefs = { get: () => ({}) } as never;
    const caller = appRouter.createCaller({ monitor, prefs });
    const res = await caller.panelHistory({ panelId: 'nope', beforeUuid: 'x', limit: 10 });
    expect(res).toEqual({ events: [], hasMore: false });
  });
});
