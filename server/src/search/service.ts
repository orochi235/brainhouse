/**
 * Main-thread handle on the search worker. Every call is a message; replies
 * are matched by id. A crashed worker is restarted after a pause, and calls
 * made while it is down fail rather than hang.
 */

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { RootSpec } from './ingest.js';
import type { HighlightSpec, QueryOptions, SearchResult } from './search.js';
import type { Transcript } from './transcript.js';
import type { IndexStatus, WorkerMessage, WorkerReply, WorkerRequest } from './worker.js';

export type { IndexStatus } from './worker.js';

const RESTART_DELAY_MS = 5000;

/** A worker request without its id, kept as a union. */
type RequestBody = WorkerRequest extends infer R
  ? R extends WorkerRequest
    ? Omit<R, 'id'>
    : never
  : never;

export function defaultSearchDbPath(): string {
  return process.env.BRAINHOUSE_SEARCH_DB ?? path.join(os.homedir(), '.brainhouse', 'search.db');
}

export class SearchService {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private roots: RootSpec[] = [];
  private stopped = false;

  constructor(private readonly dbPath: string = defaultSearchDbPath()) {}

  start(roots: RootSpec[]): void {
    this.roots = roots;
    this.spawn();
  }

  private spawn(): void {
    // Run as compiled JS from dist, or as TypeScript under tsx in dev; the
    // worker inherits the parent's loader through execArgv either way.
    const here = fileURLToPath(import.meta.url);
    const workerFile = path.join(path.dirname(here), `worker${path.extname(here)}`);
    const w = new Worker(workerFile, { workerData: { dbPath: this.dbPath } });
    this.worker = w;
    w.on('message', (reply: WorkerReply) => {
      const p = this.pending.get(reply.id);
      if (!p) return;
      this.pending.delete(reply.id);
      if (reply.ok) p.resolve(reply.value);
      else p.reject(new Error(reply.error));
    });
    w.on('error', (err) => console.error('[search] worker error:', err));
    w.on('exit', (code) => {
      this.worker = null;
      for (const p of this.pending.values()) p.reject(new Error('search worker exited'));
      this.pending.clear();
      if (this.stopped) return;
      console.error(`[search] worker exited (${code}); restarting in ${RESTART_DELAY_MS} ms`);
      setTimeout(() => {
        if (!this.stopped) this.spawn();
      }, RESTART_DELAY_MS).unref();
    });
    this.send({ type: 'roots', roots: this.roots });
  }

  private send(msg: WorkerMessage): void {
    this.worker?.postMessage(msg);
  }

  private call<T>(msg: RequestBody): Promise<T> {
    if (!this.worker) return Promise.reject(new Error('search is restarting'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.send({ ...msg, id } as WorkerMessage);
    });
  }

  setRoots(roots: RootSpec[]): void {
    this.roots = roots;
    this.send({ type: 'roots', roots });
  }

  /** The watcher read new bytes from this transcript. */
  touch(p: string): void {
    this.send({ type: 'touch', path: p });
  }

  query(q: string, opts?: QueryOptions): Promise<SearchResult> {
    return this.call({ type: 'query', q, opts });
  }

  transcript(fileId: number, highlight: HighlightSpec): Promise<Transcript | null> {
    return this.call({ type: 'transcript', fileId, highlight });
  }

  docText(docId: number): Promise<string | null> {
    return this.call({ type: 'docText', docId });
  }

  status(): Promise<IndexStatus> {
    return this.call({ type: 'status' });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.worker?.terminate();
  }
}
