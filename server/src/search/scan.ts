/**
 * What the search worker does with each transcript: which ones a scan keeps,
 * drops, and queues, where one file's next bytes come from, and what leaves
 * the index when it outgrows its cap.
 */

import { existsSync, statSync } from 'node:fs';
import { classifyPath } from '../watcher.js';
import type { Ingester, RootSpec } from './ingest.js';
import { liveSource } from './reader.js';
import type { StoredTranscripts } from './stored.js';

/** Which transcript a path holds, wherever under its root it sits. */
function identity(p: string, root: string): string | null {
  const info = classifyPath(p);
  return info && !info.is_meta ? `${root}\0${info.session_id}\0${info.agent_id ?? ''}` : null;
}

/**
 * The stored transcripts with no live file, one per transcript. Claude Code
 * moves a session's files when its project directory changes, and the store
 * keeps the copy it made at the old path, so one transcript can be stored
 * twice, or stored at one path and live at another.
 */
function storedOnly(
  live: string[],
  stored: StoredTranscripts,
  rootOf: (p: string) => string | null,
): string[] {
  const taken = new Set<string>();
  for (const p of live) {
    const root = rootOf(p);
    const id = root && identity(p, root);
    if (id) taken.add(id);
  }
  const newest = new Map<string, { path: string; mtime: number }>();
  for (const p of stored.paths()) {
    const root = rootOf(p);
    const id = root && identity(p, root);
    if (!id || taken.has(id)) continue;
    const mtime = stored.entry(p)?.mtimeMs ?? 0;
    const best = newest.get(id);
    if (!best || mtime > best.mtime) newest.set(id, { path: p, mtime });
  }
  return [...newest.values()].map((n) => n.path);
}

/**
 * Drop index rows for transcripts that are gone for good, and return the ones
 * with unread bytes, newest first. A transcript whose live file is gone stays
 * for as long as the store holds it, and nothing is dropped while the store
 * cannot be reached.
 */
export function planScan(
  ingest: Ingester,
  live: string[],
  stored: StoredTranscripts,
  rootOf: (p: string) => string | null,
): string[] {
  const gone = stored.state === 'open' ? storedOnly(live, stored, rootOf) : [];
  if (stored.state !== 'unreachable') ingest.prune(new Set([...live, ...gone]));

  const stale: Array<{ path: string; mtime: number }> = [];
  for (const p of live) {
    if (!ingest.needsWork(p)) continue;
    try {
      stale.push({ path: p, mtime: statSync(p).mtimeMs });
    } catch {}
  }
  for (const p of gone) {
    const entry = stored.entry(p);
    if (entry && ingest.needsStored(p, entry.size)) stale.push({ path: p, mtime: entry.mtimeMs });
  }
  stale.sort((a, b) => b.mtime - a.mtime);
  return stale.map((s) => s.path);
}

/**
 * Index the next stretch of one transcript, from its live file or, once that
 * is gone, from the store. Returns true once there is nothing more to do for
 * it now. A stored transcript is not read into an index already over its cap.
 */
export function stepFile(
  ingest: Ingester,
  stored: StoredTranscripts,
  p: string,
  root: RootSpec,
  maxBytes: number,
  overCap: () => boolean,
): boolean {
  const live = liveSource(p);
  if (live) return ingest.step(p, root, maxBytes, live);
  if (stored.state === 'unreachable') return true;
  const entry = stored.entry(p);
  if (!entry) return ingest.step(p, root, maxBytes, null);
  if (!ingest.needsStored(p, entry.size)) return true;
  if (overCap()) {
    ingest.shelve(p, root, entry.size);
    return true;
  }
  const done = ingest.step(p, root, maxBytes, stored.source(p));
  if (done) stored.release();
  return done;
}

/**
 * While the index is over its cap, take the stored-only transcript that ended
 * longest ago out of search. Returns how many went. Live transcripts are
 * never touched, and a shelved one stays in the store.
 */
export function enforceCap(
  ingest: Ingester,
  stored: StoredTranscripts,
  overCap: () => boolean,
): number {
  if (stored.state !== 'open' || !overCap()) return 0;
  let n = 0;
  for (const p of ingest.indexedOldestFirst()) {
    const entry = stored.entry(p);
    if (!entry || existsSync(p)) continue;
    ingest.shelve(p, null, entry.size);
    n++;
    if (!overCap()) break;
  }
  return n;
}
