import { mkdtempSync, writeFileSync } from 'node:fs';
import { appendFile, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { type HookEvent, HookEventSchema, HookEventWatcher } from './hookEvents.js';

describe('HookEventSchema', () => {
  test('accepts a minimal Stop event', () => {
    const raw = { kind: 'stop', session_id: 'abc', ts: 1700000000 };
    expect(HookEventSchema.parse(raw)).toMatchObject(raw);
  });

  test('rejects unknown kinds', () => {
    const result = HookEventSchema.safeParse({ kind: 'wat', session_id: 'a', ts: 0 });
    expect(result.success).toBe(false);
  });

  test('rejects empty session_id', () => {
    const result = HookEventSchema.safeParse({ kind: 'stop', session_id: '', ts: 0 });
    expect(result.success).toBe(false);
  });

  test('accepts auto_title with a title payload', () => {
    const raw = {
      kind: 'auto_title',
      session_id: 'S',
      title: 'A better title',
      ts: 1700000000,
    };
    const result = HookEventSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.title).toBe('A better title');
  });
});

describe('HookEventWatcher', () => {
  let dir: string;
  let received: HookEvent[];
  let watcher: HookEventWatcher;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'brainhouse-hooks-'));
    await mkdir(dir, { recursive: true });
    received = [];
    watcher = new HookEventWatcher(dir, (e) => {
      received.push(e);
    });
  });

  afterEach(async () => {
    await watcher.stop();
    await rm(dir, { recursive: true, force: true });
  });

  test('reads existing lines on start', async () => {
    const file = path.join(dir, 'sess1.jsonl');
    writeFileSync(file, `${JSON.stringify({ kind: 'stop', session_id: 'sess1', ts: 1 })}\n`);
    await watcher.start();
    await new Promise((r) => setTimeout(r, 150));
    expect(received).toEqual([{ kind: 'stop', session_id: 'sess1', ts: 1 }]);
  });

  test('appended lines arrive once each', async () => {
    await watcher.start();
    await new Promise((r) => setTimeout(r, 50));
    const file = path.join(dir, 'sess2.jsonl');
    await appendFile(
      file,
      `${JSON.stringify({ kind: 'notification', session_id: 'sess2', ts: 5 })}\n`,
    );
    await new Promise((r) => setTimeout(r, 200));
    await appendFile(
      file,
      `${JSON.stringify({ kind: 'subagent_stop', session_id: 'sess2', ts: 6 })}\n`,
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(received.map((e) => e.kind)).toEqual(['notification', 'subagent_stop']);
  });

  test('silently skips malformed lines', async () => {
    await watcher.start();
    await new Promise((r) => setTimeout(r, 50));
    const file = path.join(dir, 'sess3.jsonl');
    await appendFile(file, 'not json\n');
    await appendFile(file, `${JSON.stringify({ kind: 'bogus', session_id: 'sess3', ts: 1 })}\n`);
    await appendFile(file, `${JSON.stringify({ kind: 'stop', session_id: 'sess3', ts: 1 })}\n`);
    await new Promise((r) => setTimeout(r, 200));
    expect(received).toHaveLength(1);
    expect(received[0]?.kind).toBe('stop');
  });
});
