import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PREFS, PrefsSchema, PrefsStore } from './prefs.js';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'brainhouse-prefs-'));
  file = path.join(dir, 'prefs.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('PrefsStore', () => {
  it('returns defaults when no file exists', async () => {
    const store = new PrefsStore(file);
    await store.load();
    expect(store.get()).toEqual(DEFAULT_PREFS);
  });

  it('persists an update and reloads it', async () => {
    const store = new PrefsStore(file);
    await store.load();
    await store.update({
      roots: [{ path: '/Users/mike/.claude', label: 'personal' }],
      workspace: { minCols: 2, minRows: 1, maxTileSpan: 600 },
    });
    const fresh = new PrefsStore(file);
    await fresh.load();
    const p = fresh.get();
    expect(p.workspace.minCols).toBe(2);
    expect(p.workspace.maxTileSpan).toBe(600);
    expect(p.roots).toEqual([{ path: '/Users/mike/.claude', label: 'personal' }]);
    // Untouched fields keep their schema defaults.
    expect(p.timings.idleSeconds).toBe(DEFAULT_PREFS.timings.idleSeconds);
  });

  it('rejects invalid colors via the schema', async () => {
    const store = new PrefsStore(file);
    await store.load();
    await expect(store.update({ roots: [{ path: '/x', color: 'not-a-hex' }] })).rejects.toThrow();
  });

  it('keeps defaults when the file is malformed', async () => {
    await writeFile(file, '{ this is not json', 'utf8');
    const store = new PrefsStore(file);
    await store.load();
    expect(store.get()).toEqual(DEFAULT_PREFS);
  });

  it('writes the file atomically with a trailing newline', async () => {
    const store = new PrefsStore(file);
    await store.load();
    await store.update({ workspace: { minCols: 1, minRows: 2, maxTileSpan: 0 } });
    const raw = await readFile(file, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(JSON.parse(raw).workspace.minRows).toBe(2);
  });

  it('rejects invalid types via the schema', async () => {
    const store = new PrefsStore(file);
    await store.load();
    // minCols must be ≥1.
    await expect(
      store.update({ workspace: { minCols: 0, minRows: 1, maxTileSpan: 0 } }),
    ).rejects.toThrow();
  });
});

describe('discovery prefs', () => {
  it('has conservative defaults', () => {
    expect(DEFAULT_PREFS.discovery).toEqual({
      uiWindowSeconds: 172800, // 48h
      backgroundMaxAgeSeconds: 7776000, // 90d
      backgroundBatchSize: 25,
      backgroundIntervalMs: 4000,
    });
  });

  it('fills discovery defaults when the group is omitted', () => {
    const parsed = PrefsSchema.parse({});
    expect(parsed.discovery.uiWindowSeconds).toBe(172800);
  });
});
