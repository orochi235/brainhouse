/**
 * The search worker thread: owns the search database, catches it up with the
 * transcripts, and answers queries. Indexing runs in small steps, and messages
 * are read between steps, so a query waits at most one step behind a build.
 */

import { statSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { listTranscripts, type RootSpec } from './ingest.js';
import type { HighlightSpec, QueryOptions } from './search.js';
import { SearchIndex } from './searchIndex.js';

export type WorkerRequest =
  | { type: 'query'; id: number; q: string; opts?: QueryOptions }
  | { type: 'transcript'; id: number; fileId: number; highlight: HighlightSpec }
  | { type: 'docText'; id: number; docId: number }
  | { type: 'status'; id: number };

export type WorkerMessage =
  | WorkerRequest
  | { type: 'roots'; roots: RootSpec[] }
  | { type: 'touch'; path: string };

export type WorkerReply =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string };

export interface IndexStatus {
  files: number;
  docs: number;
  /** Files waiting to be read. */
  pending: number;
  /** True until the first pass over every root has finished. */
  building: boolean;
}

/** Bytes per indexing step. Reading and indexing 1 MB takes tens of
 * milliseconds, which bounds how long a query can wait. */
const STEP_BYTES = 1024 * 1024;
/** Backstop rescan for files the watcher never reported. */
const RESCAN_MS = 10 * 60 * 1000;

const { dbPath } = workerData as { dbPath: string };
if (!parentPort) throw new Error('search worker must run in a worker thread');
const port = parentPort;

const index = new SearchIndex(dbPath);
let roots: RootSpec[] = [];
/** Touched by the watcher: indexed before anything in `cold`. */
const hot = new Set<string>();
/** From a scan, newest first. */
let cold: string[] = [];
let building = true;
const requests: WorkerRequest[] = [];
let wake: (() => void) | null = null;

function rootFor(p: string): RootSpec | null {
  return roots.find((r) => p.startsWith(`${r.path}/`)) ?? null;
}

async function scan(): Promise<void> {
  const listed = await listTranscripts(roots);
  index.ingest.prune(new Set(listed.map((l) => l.path)));
  const stale: Array<{ path: string; mtime: number }> = [];
  for (const { path: p } of listed) {
    if (!index.ingest.needsWork(p)) continue;
    let mtime = 0;
    try {
      mtime = statSync(p).mtimeMs;
    } catch {
      continue;
    }
    stale.push({ path: p, mtime });
  }
  stale.sort((a, b) => b.mtime - a.mtime);
  cold = stale.map((s) => s.path);
  poke();
}

function answer(req: WorkerRequest): void {
  try {
    let value: unknown;
    if (req.type === 'query') value = index.query(req.q, req.opts);
    else if (req.type === 'transcript') value = index.transcript(req.fileId, req.highlight);
    else if (req.type === 'docText') value = index.docText(req.docId);
    else
      value = { ...index.stats(), pending: hot.size + cold.length, building } satisfies IndexStatus;
    port.postMessage({ id: req.id, ok: true, value } satisfies WorkerReply);
  } catch (err) {
    port.postMessage({
      id: req.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    } satisfies WorkerReply);
  }
}

function poke(): void {
  wake?.();
  wake = null;
}

port.on('message', (msg: WorkerMessage) => {
  if (msg.type === 'roots') {
    roots = msg.roots;
    building = true;
    void scan().then(() => {
      if (cold.length === 0 && hot.size === 0) building = false;
    });
  } else if (msg.type === 'touch') {
    if (rootFor(msg.path)) hot.add(msg.path);
  } else {
    requests.push(msg);
  }
  poke();
});

/** One unit of indexing; false when there is nothing to do. A file that
 * isn't caught up stays at the front so it finishes before the next. */
function step(): boolean {
  let p: string | undefined;
  let fromHot = false;
  const firstHot = hot.values().next();
  if (!firstHot.done) {
    p = firstHot.value;
    fromHot = true;
  } else p = cold[0];
  if (!p) return false;
  const root = rootFor(p);
  let done = true;
  if (root) {
    try {
      done = index.ingest.step(p, root, STEP_BYTES);
    } catch (err) {
      console.error(`[search] indexing ${p} failed:`, err);
    }
  }
  if (done) {
    if (fromHot) hot.delete(p);
    else cold.shift();
    if (building && hot.size === 0 && cold.length === 0) building = false;
  }
  return true;
}

async function loop(): Promise<never> {
  for (;;) {
    for (let req = requests.shift(); req; req = requests.shift()) answer(req);
    if (step()) {
      await new Promise((r) => setImmediate(r));
      continue;
    }
    await new Promise<void>((r) => {
      wake = r;
    });
  }
}

setInterval(() => void scan(), RESCAN_MS).unref();
void loop();
