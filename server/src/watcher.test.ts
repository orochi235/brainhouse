import { closeSync, mkdirSync, openSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Event } from './parser.js';
import { Store } from './store.js';
import { classifyPath, TranscriptWatcher } from './watcher.js';

function record(uuid: string, text: string, session: string): Record<string, unknown> {
  return {
    type: 'assistant',
    uuid,
    sessionId: session,
    timestamp: 't',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  };
}

describe('classifyPath', () => {
  it('classifies a parent jsonl', () => {
    const info = classifyPath('/tmp/-Users-mike-src-foo/abc-123.jsonl');
    expect(info).toEqual({ session_id: 'abc-123', agent_id: null, is_meta: false });
  });

  it('classifies a subagent jsonl', () => {
    const info = classifyPath('/tmp/proj/session-xyz/subagents/agent-aaa.jsonl');
    expect(info).toEqual({ session_id: 'session-xyz', agent_id: 'aaa', is_meta: false });
  });

  it('classifies a subagent meta', () => {
    const info = classifyPath('/tmp/proj/session-xyz/subagents/agent-aaa.meta.json');
    expect(info).toEqual({ session_id: 'session-xyz', agent_id: 'aaa', is_meta: true });
  });

  it('returns null for unrelated paths', () => {
    expect(classifyPath('/tmp/proj/.DS_Store')).toBeNull();
    expect(classifyPath('/tmp/proj/notes.txt')).toBeNull();
  });

  it('jsonl and meta sibling produce the same bare agent_id', () => {
    const jsonl = classifyPath('/tmp/proj/sess/subagents/agent-zzz.jsonl');
    const meta = classifyPath('/tmp/proj/sess/subagents/agent-zzz.meta.json');
    expect(jsonl?.agent_id).toBe(meta?.agent_id);
    expect(jsonl?.agent_id).toBe('zzz');
  });
});

describe('TranscriptWatcher', () => {
  let dir: string;
  let events: Event[];
  let sink: (e: Event) => void;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'brainhouse-watcher-'));
    events = [];
    sink = (e) => events.push(e);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('bootstrap reads a full jsonl file', async () => {
    const proj = path.join(dir, 'proj');
    mkdirSync(proj, { recursive: true });
    const f = path.join(proj, 'sess-1.jsonl');
    writeFileSync(
      f,
      `${[0, 1, 2].map((i) => JSON.stringify(record(`u${i}`, `hi ${i}`, 'sess-1'))).join('\n')}\n`,
    );
    const w = new TranscriptWatcher([dir], sink, { bootstrapAgeSeconds: 10_000 });
    await w.bootstrap();
    expect(events.map((e) => (e.kind === 'assistant_text' ? e.payload.text : null))).toEqual([
      'hi 0',
      'hi 1',
      'hi 2',
    ]);
    expect(events.every((e) => e.session_id === 'sess-1' && e.agent_id === null)).toBe(true);
  });

  it('appending only emits new events', async () => {
    const proj = path.join(dir, 'proj');
    mkdirSync(proj, { recursive: true });
    const f = path.join(proj, 'sess-1.jsonl');
    writeFileSync(f, `${JSON.stringify(record('u1', 'first', 'sess-1'))}\n`);
    const w = new TranscriptWatcher([dir], sink, { bootstrapAgeSeconds: 10_000 });
    await w.bootstrap();
    expect(events).toHaveLength(1);

    const fd = openSync(f, 'a');
    writeSync(fd, `${JSON.stringify(record('u2', 'second', 'sess-1'))}\n`);
    closeSync(fd);
    await w.processPath(f);
    expect(events.map((e) => (e.kind === 'assistant_text' ? e.payload.text : null))).toEqual([
      'first',
      'second',
    ]);
  });

  it('partial trailing line is buffered until newline arrives', async () => {
    const proj = path.join(dir, 'proj');
    mkdirSync(proj, { recursive: true });
    const f = path.join(proj, 'sess-1.jsonl');
    const fullLine = JSON.stringify(record('u1', 'complete', 'sess-1'));
    const partial = JSON.stringify(record('u2', 'partial', 'sess-1'));
    writeFileSync(f, `${fullLine}\n${partial.slice(0, 20)}`);
    const w = new TranscriptWatcher([dir], sink, { bootstrapAgeSeconds: 10_000 });
    await w.processPath(f);
    expect(events.map((e) => (e.kind === 'assistant_text' ? e.payload.text : null))).toEqual([
      'complete',
    ]);

    const fd = openSync(f, 'a');
    writeSync(fd, `${partial.slice(20)}\n`);
    closeSync(fd);
    await w.processPath(f);
    expect(events.map((e) => (e.kind === 'assistant_text' ? e.payload.text : null))).toEqual([
      'complete',
      'partial',
    ]);
  });

  it('jsonl row agentId and meta sidecar funnel into the same panel id', async () => {
    const subDir = path.join(dir, 'proj', 'sess-1', 'subagents');
    mkdirSync(subDir, { recursive: true });
    const meta = path.join(subDir, 'agent-ccc.meta.json');
    writeFileSync(meta, JSON.stringify({ agentType: 'Explore', description: 'find X' }));
    const jsonl = path.join(subDir, 'agent-ccc.jsonl');
    // Critically: the row's `agentId` is the bare uuid (no `agent-` prefix),
    // matching how Claude Code writes the JSONL. Path-derived id must also
    // strip the prefix or we end up with two panels for one subagent.
    const row = { ...record('u1', 'from sub', 'sess-1'), agentId: 'ccc' };
    writeFileSync(jsonl, `${JSON.stringify(row)}\n`);
    const w = new TranscriptWatcher([dir], sink, { bootstrapAgeSeconds: 10_000 });
    await w.processPath(jsonl);
    expect(events.map((e) => e.agent_id)).toEqual(['ccc', 'ccc']);
  });

  it('subagent jsonl carries agent_id derived from path', async () => {
    const subDir = path.join(dir, 'proj', 'sess-1', 'subagents');
    mkdirSync(subDir, { recursive: true });
    const f = path.join(subDir, 'agent-bbb.jsonl');
    writeFileSync(f, `${JSON.stringify(record('u1', 'from sub', 'sess-1'))}\n`);
    const w = new TranscriptWatcher([dir], sink, { bootstrapAgeSeconds: 10_000 });
    await w.processPath(f);
    // Two events: the synthetic subagent-meta lookup (no .meta.json so it's
    // skipped) + the assistant_text. With no meta on disk, just one event.
    expect(events).toHaveLength(1);
    expect(events[0]?.agent_id).toBe('bbb');
    expect(events[0]?.session_id).toBe('sess-1');
  });

  it('first-sight read of sibling .meta.json emits a synthetic event before the body', async () => {
    const subDir = path.join(dir, 'proj', 'sess-1', 'subagents');
    mkdirSync(subDir, { recursive: true });
    const meta = path.join(subDir, 'agent-bbb.meta.json');
    writeFileSync(meta, JSON.stringify({ agentType: 'Explore', description: 'find X' }));
    const jsonl = path.join(subDir, 'agent-bbb.jsonl');
    writeFileSync(jsonl, `${JSON.stringify(record('u1', 'from sub', 'sess-1'))}\n`);
    const w = new TranscriptWatcher([dir], sink, { bootstrapAgeSeconds: 10_000 });
    await w.processPath(jsonl);
    expect(events).toHaveLength(2);
    const [metaEv, bodyEv] = events;
    expect(metaEv?.kind).toBe('meta');
    if (metaEv?.kind === 'meta') {
      expect(metaEv.payload.record_type).toBe('subagent-meta');
      expect((metaEv.payload.raw as Record<string, string>).agentType).toBe('Explore');
    }
    expect(bodyEv?.kind).toBe('assistant_text');
  });

  it('processing a .meta.json file directly emits a synthetic event', async () => {
    const subDir = path.join(dir, 'proj', 'sess-1', 'subagents');
    mkdirSync(subDir, { recursive: true });
    const meta = path.join(subDir, 'agent-bbb.meta.json');
    writeFileSync(meta, JSON.stringify({ agentType: 'Explore', description: 'find X' }));
    const w = new TranscriptWatcher([dir], sink, { bootstrapAgeSeconds: 10_000 });
    await w.processPath(meta);
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e?.kind).toBe('meta');
    expect(e?.agent_id).toBe('bbb');
    if (e?.kind === 'meta') {
      expect(e.payload.record_type).toBe('subagent-meta');
    }
  });

  it('bootstrap skips files older than the age window', async () => {
    const proj = path.join(dir, 'proj');
    mkdirSync(proj, { recursive: true });
    const fresh = path.join(proj, 'fresh.jsonl');
    const stale = path.join(proj, 'stale.jsonl');
    writeFileSync(fresh, `${JSON.stringify(record('u1', 'fresh', 'fresh'))}\n`);
    writeFileSync(stale, `${JSON.stringify(record('u2', 'stale', 'stale'))}\n`);
    const oldSeconds = (Date.now() - 60 * 60 * 1000) / 1000;
    utimesSync(stale, oldSeconds, oldSeconds);

    const w = new TranscriptWatcher([dir], sink, { bootstrapAgeSeconds: 10 * 60 });
    await w.bootstrap();
    expect(events.map((e) => (e.kind === 'assistant_text' ? e.payload.text : null))).toEqual([
      'fresh',
    ]);
  });

  it('unrelated file is ignored', async () => {
    const proj = path.join(dir, 'proj');
    mkdirSync(proj, { recursive: true });
    const p = path.join(proj, 'notes.txt');
    writeFileSync(p, 'hello');
    const w = new TranscriptWatcher([dir], sink, { bootstrapAgeSeconds: 10_000 });
    await w.processPath(p);
    expect(events).toEqual([]);
  });

  it('chokidar observer picks up live appends', async () => {
    const proj = path.join(dir, 'proj');
    mkdirSync(proj, { recursive: true });
    const f = path.join(proj, 'sess-live.jsonl');
    writeFileSync(f, `${JSON.stringify(record('u1', 'first', 'sess-live'))}\n`);
    const w = new TranscriptWatcher([dir], sink, {
      bootstrapAgeSeconds: 10_000,
      chokidarOptions: { usePolling: true, interval: 30 },
    });
    await w.start({ watch: true });
    try {
      expect(events.some((e) => e.kind === 'assistant_text' && e.payload.text === 'first')).toBe(
        true,
      );
      // Brief settle so the append's mtime differs from bootstrap's write
      // by more than fs-poll granularity.
      await new Promise((r) => setTimeout(r, 50));
      const fd = openSync(f, 'a');
      writeSync(fd, `${JSON.stringify(record('u2', 'second', 'sess-live'))}\n`);
      closeSync(fd);

      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (events.some((e) => e.kind === 'assistant_text' && e.payload.text === 'second')) break;
        await new Promise((r) => setTimeout(r, 30));
      }
      expect(events.some((e) => e.kind === 'assistant_text' && e.payload.text === 'second')).toBe(
        true,
      );
    } finally {
      await w.stop();
    }
  });

  describe('bootstrap_offsets persistence', () => {
    it('persists byte offset after tailing; resumes from there on next start', async () => {
      const store = Store.open(':memory:');
      const f = path.join(dir, 'sess-x.jsonl');
      const line1 = `${JSON.stringify(record('u1', 'first', 'sess-x'))}\n`;
      const line2 = `${JSON.stringify(record('u2', 'second', 'sess-x'))}\n`;

      // First run: read first line, persist offset.
      const w1 = new TranscriptWatcher([dir], sink, {
        bootstrapAgeSeconds: 10_000,
        store,
      });
      writeFileSync(f, line1);
      await w1.start({ watch: false });
      const recordedOffset = store.getBootstrapOffset(f);
      expect(recordedOffset).toBe(Buffer.byteLength(line1));

      // Append another line, then "restart" by constructing a fresh watcher
      // backed by the same store. The new watcher should hydrate the offset
      // and only emit the appended line on its bootstrap pass.
      writeFileSync(f, line1 + line2);
      events.length = 0;
      const w2 = new TranscriptWatcher([dir], sink, {
        bootstrapAgeSeconds: 10_000,
        store,
      });
      await w2.start({ watch: false });
      const texts = events.flatMap((e) =>
        e.kind === 'assistant_text' && typeof e.payload.text === 'string' ? [e.payload.text] : [],
      );
      expect(texts).toEqual(['second']);
      expect(store.getBootstrapOffset(f)).toBe(Buffer.byteLength(line1 + line2));
      store.close();
    });

    it('drops offset entries for files that no longer exist', async () => {
      const store = Store.open(':memory:');
      // Pre-seed a stale offset for a path that was never created.
      store.setBootstrapOffset(path.join(dir, 'gone.jsonl'), 9999);
      expect(store.getBootstrapOffset(path.join(dir, 'gone.jsonl'))).toBe(9999);
      const w = new TranscriptWatcher([dir], sink, { bootstrapAgeSeconds: 10_000, store });
      await w.start({ watch: false });
      // The hydrate pass pruned the dead entry.
      expect(store.getBootstrapOffset(path.join(dir, 'gone.jsonl'))).toBeNull();
      store.close();
    });

    it('bypasses the bootstrapAgeSeconds cutoff for files that have a saved offset', async () => {
      const store = Store.open(':memory:');
      const f = path.join(dir, 'ancient.jsonl');
      const line = `${JSON.stringify(record('u1', 'old', 'ancient'))}\n`;
      writeFileSync(f, line);
      // Backdate the file so it's older than the cutoff.
      const twoDaysAgo = (Date.now() - 2 * 86_400_000) / 1000;
      utimesSync(f, twoDaysAgo, twoDaysAgo);

      // First watcher: tight cutoff, no saved offset → skipped.
      const w1 = new TranscriptWatcher([dir], sink, { bootstrapAgeSeconds: 60, store });
      await w1.start({ watch: false });
      expect(events.length).toBe(0);

      // Seed a saved offset of 0 (pretend we'd seen but not read this file).
      store.setBootstrapOffset(f, 0);

      // Second watcher: same tight cutoff, but the saved offset overrides
      // the mtime check so the line gets emitted.
      events.length = 0;
      const w2 = new TranscriptWatcher([dir], sink, { bootstrapAgeSeconds: 60, store });
      await w2.start({ watch: false });
      expect(events.some((e) => e.kind === 'assistant_text' && e.payload.text === 'old')).toBe(
        true,
      );
      store.close();
    });
  });
});
