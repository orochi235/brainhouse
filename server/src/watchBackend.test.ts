import { mkdtempSync } from 'node:fs';
import { mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type Watcher, nativeRecursiveSupported, startWatcher } from './watchBackend.js';

async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('nativeRecursiveSupported', () => {
  it('is true on macOS and Windows, false elsewhere', () => {
    expect(nativeRecursiveSupported('darwin')).toBe(true);
    expect(nativeRecursiveSupported('win32')).toBe(true);
    expect(nativeRecursiveSupported('linux')).toBe(false);
    expect(nativeRecursiveSupported('aix')).toBe(false);
  });
});

// Exercise each backend against the real filesystem. The native path only
// works where the OS has a recursive watcher, so gate it; the chokidar path is
// forced and runs everywhere.
const backends: Array<'native' | 'chokidar'> = ['chokidar'];
if (nativeRecursiveSupported()) backends.unshift('native');

describe.each(backends)('startWatcher (%s backend)', (backend) => {
  let dir: string;
  let w: Watcher | null = null;

  afterEach(async () => {
    await w?.close();
    w = null;
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('emits on a new file and on append', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'wb-'));
    const hits: string[] = [];
    w = startWatcher([dir], { recursive: true, backend, onEvent: (p) => hits.push(p) });
    await w.ready;

    const f = path.join(dir, 'a.jsonl');
    await writeFile(f, 'one\n');
    await waitFor(() => hits.some((p) => path.resolve(p) === path.resolve(f)));

    hits.length = 0;
    await writeFile(f, 'one\ntwo\n');
    await waitFor(() => hits.some((p) => path.resolve(p) === path.resolve(f)));
  });

  it('emits for nested files when recursive', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'wb-'));
    const hits: string[] = [];
    w = startWatcher([dir], { recursive: true, backend, onEvent: (p) => hits.push(p) });
    await w.ready;

    const sub = path.join(dir, 'proj', 'sess');
    await mkdir(sub, { recursive: true });
    const f = path.join(sub, 'deep.jsonl');
    await writeFile(f, 'x\n');
    await waitFor(() => hits.some((p) => path.resolve(p) === path.resolve(f)));
  });

  it('stops emitting after close', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'wb-'));
    const hits: string[] = [];
    w = startWatcher([dir], { recursive: true, backend, onEvent: (p) => hits.push(p) });
    await w.ready;
    await w.close();
    w = null;

    await writeFile(path.join(dir, 'after.jsonl'), 'y\n');
    await new Promise((r) => setTimeout(r, 150));
    expect(hits).toHaveLength(0);
  });
});

// The reconcile backstop is native-only; it re-emits recently-touched files
// even without a live event (covers coalesced/dropped FSEvents).
(nativeRecursiveSupported() ? describe : describe.skip)('native reconcile backstop', () => {
  let dir: string;
  let w: Watcher | null = null;

  afterEach(async () => {
    await w?.close();
    w = null;
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  // FSEvents can replay a just-before-start write as a live event, so both
  // tests settle + clear `hits` after start(); only the reconcile scan can add
  // hits after that point, which is exactly what we want to observe.
  it('re-emits a recently-modified file via the reconcile scan', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'wb-'));
    const f = path.join(dir, 'recent.jsonl');
    await writeFile(f, 'z\n');

    const hits: string[] = [];
    w = startWatcher([dir], {
      recursive: true,
      backend: 'native',
      reconcileWindowMs: 60_000,
      reconcileIntervalMs: 40,
      onEvent: (p) => hits.push(p),
    });
    await w.ready;
    await new Promise((r) => setTimeout(r, 150)); // let any FSEvents replay flush
    hits.length = 0;

    // In-window file → reconcile re-emits it on a subsequent tick.
    await waitFor(() => hits.some((p) => path.resolve(p) === path.resolve(f)));
  });

  it('does not re-emit a file older than the reconcile window', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'wb-'));
    const f = path.join(dir, 'stale.jsonl');
    await writeFile(f, 'z\n');
    const old = new Date(Date.now() - 10 * 60_000);
    await utimes(f, old, old);

    const hits: string[] = [];
    w = startWatcher([dir], {
      recursive: true,
      backend: 'native',
      reconcileWindowMs: 60_000,
      reconcileIntervalMs: 40,
      onEvent: (p) => hits.push(p),
    });
    await w.ready;
    await new Promise((r) => setTimeout(r, 150)); // flush any FSEvents replay
    hits.length = 0;

    // Out-of-window file → several reconcile ticks pass with no re-emit.
    await new Promise((r) => setTimeout(r, 250));
    expect(hits).toHaveLength(0);
  });
});
