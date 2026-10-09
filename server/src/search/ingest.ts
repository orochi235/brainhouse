/**
 * Reads transcripts into the search database, each from the byte offset where
 * the last read stopped.
 */

import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { type Event, parseLine } from '../parser.js';
import { findRepoRoot } from '../session.js';
import { classifyPath } from '../watcher.js';
import { type DB, parseTs } from './db.js';
import { eventToDoc } from './extract.js';

export interface RootSpec {
  path: string;
  /** Account label (`CC`, `PW`, …) stamped on every file under this root. */
  account: string | null;
}

/** A line can be a multi-megabyte image paste; never read more than this
 * looking for one newline. */
const MAX_LINE_BYTES = 64 * 1024 * 1024;

/** Every transcript under the roots, with the root it came from. */
export async function listTranscripts(
  roots: RootSpec[],
): Promise<Array<{ path: string; root: RootSpec }>> {
  const out: Array<{ path: string; root: RootSpec }> = [];
  const visit = async (dir: string, root: RootSpec) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await visit(full, root);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push({ path: full, root });
    }
  };
  for (const root of roots) await visit(root.path, root);
  return out;
}

export class Ingester {
  /** tool_use_id → tool name for the file being indexed, so a result read in
   * the same chunk as its call skips the DB lookup. */
  private toolNames = new Map<string, string>();
  private toolNamesFile = -1;

  constructor(private readonly db: DB) {}

  /** True when the file has bytes the index hasn't read, or shrank. */
  needsWork(p: string): boolean {
    let st: { size: number; mtimeMs: number };
    try {
      st = statSync(p);
    } catch {
      return this.db.prepare('SELECT 1 FROM files WHERE path = ?').get(p) !== undefined;
    }
    const row = this.db.prepare('SELECT size, mtime FROM files WHERE path = ?').get(p) as
      | { size: number; mtime: number }
      | undefined;
    return !row || row.size !== st.size || row.mtime !== st.mtimeMs;
  }

  /**
   * Index the next stretch of one file: about `maxBytes`, more only when a
   * single line is longer. Returns true once the file is caught up. One
   * transaction per call, so a crash never leaves half a chunk indexed.
   */
  step(p: string, root: RootSpec, maxBytes = 4 * 1024 * 1024): boolean {
    let st: { size: number; mtimeMs: number };
    try {
      st = statSync(p);
    } catch {
      this.removeFile(p);
      return true;
    }
    const info = classifyPath(p);
    if (!info || info.is_meta) return true;
    let row = this.db.prepare('SELECT id, offset, cwd, last_ts FROM files WHERE path = ?').get(p) as
      | { id: number; offset: number; cwd: string | null; last_ts: number | null }
      | undefined;
    if (!row) {
      const r = this.db
        .prepare('INSERT INTO files (path, session_id, agent_id, account) VALUES (?, ?, ?, ?)')
        .run(p, info.session_id, info.agent_id, root.account);
      row = { id: Number(r.lastInsertRowid), offset: 0, cwd: null, last_ts: null };
    }
    const fileId = row.id;
    let offset = row.offset;
    let lastTs = row.last_ts;
    this.db.exec('BEGIN');
    try {
      if (st.size < offset) {
        // Truncated or rewritten: start over.
        this.deleteDocs(fileId);
        this.db
          .prepare('UPDATE files SET offset = 0, first_ts = NULL, last_ts = NULL WHERE id = ?')
          .run(fileId);
        offset = 0;
        lastTs = null;
      }
      const { buf, sawEnd } = readCompleteLines(p, offset, st.size, maxBytes);
      if (buf) {
        this.indexLines(fileId, info, buf.toString('utf8'), row.cwd, lastTs, st.mtimeMs / 1000);
        offset += buf.length;
      }
      const caughtUp = sawEnd;
      // The stat is recorded only once caught up, so needsWork() keeps
      // answering yes while a big file is part way through.
      this.db
        .prepare('UPDATE files SET offset = ?, size = ?, mtime = ? WHERE id = ?')
        .run(offset, caughtUp ? st.size : -1, caughtUp ? st.mtimeMs : -1, fileId);
      this.db.exec('COMMIT');
      return caughtUp;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private indexLines(
    fileId: number,
    info: { session_id: string; agent_id: string | null },
    text: string,
    knownCwd: string | null,
    lastTs: number | null,
    mtime: number,
  ): void {
    if (this.toolNamesFile !== fileId) {
      this.toolNames = new Map();
      this.toolNamesFile = fileId;
    }
    const lookupTool = this.db.prepare('SELECT tool FROM docs WHERE file_id = ? AND tuid = ?');
    const toolNameFor = (id: string) =>
      this.toolNames.get(id) ??
      (lookupTool.get(fileId, id) as { tool: string } | undefined)?.tool ??
      null;
    const insDoc = this.db.prepare(
      'INSERT INTO docs (file_id, event_uuid, ts, kind, tool, tuid, is_error, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const insFts = this.db.prepare('INSERT INTO docs_fts (rowid, text) VALUES (?, ?)');
    let cwd = knownCwd;
    let ts = lastTs;
    let firstTs: number | null = null;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let events: Event[];
      try {
        const raw = JSON.parse(line);
        if (!raw || typeof raw !== 'object') continue;
        events = parseLine(raw as Record<string, unknown>, info);
      } catch {
        continue;
      }
      for (const e of events) {
        if (!cwd && e.cwd) cwd = e.cwd;
        ts = parseTs(e.ts) ?? ts ?? mtime;
        firstTs ??= ts;
        const doc = eventToDoc(e, toolNameFor);
        if (!doc) continue;
        if (doc.tool_use_id && doc.tool) this.toolNames.set(doc.tool_use_id, doc.tool);
        const r = insDoc.run(
          fileId,
          doc.event_uuid,
          ts,
          doc.kind,
          doc.tool,
          doc.tool_use_id,
          doc.is_error ? 1 : 0,
          doc.text,
        );
        insFts.run(r.lastInsertRowid, doc.text);
      }
    }
    this.db
      .prepare(
        `UPDATE files SET cwd = ?, repo_root = COALESCE(repo_root, ?),
           first_ts = COALESCE(first_ts, ?), last_ts = COALESCE(?, last_ts) WHERE id = ?`,
      )
      .run(cwd, cwd ? findRepoRoot(cwd) : null, firstTs, ts, fileId);
  }

  private deleteDocs(fileId: number): void {
    this.db
      .prepare(
        "INSERT INTO docs_fts (docs_fts, rowid, text) SELECT 'delete', id, text FROM docs WHERE file_id = ?",
      )
      .run(fileId);
    this.db.prepare('DELETE FROM docs WHERE file_id = ?').run(fileId);
  }

  removeFile(p: string): void {
    const row = this.db.prepare('SELECT id FROM files WHERE path = ?').get(p) as
      | { id: number }
      | undefined;
    if (!row) return;
    this.db.exec('BEGIN');
    this.deleteDocs(row.id);
    this.db.prepare('DELETE FROM files WHERE id = ?').run(row.id);
    this.db.exec('COMMIT');
  }

  /** Drop every indexed file not in `keep`: deleted, or under a root that is
   * no longer configured. Returns how many went. */
  prune(keep: Set<string>): number {
    const rows = this.db.prepare('SELECT path FROM files').all() as Array<{ path: string }>;
    let n = 0;
    for (const { path: p } of rows) {
      if (keep.has(p)) continue;
      this.removeFile(p);
      n++;
    }
    return n;
  }
}

/** Bytes from `offset` through the last newline, reading at most `maxBytes`
 * unless one line is longer; `buf` is null when there is no complete line
 * yet. `sawEnd` says the read reached end of file, so nothing after `buf`
 * is ready. */
function readCompleteLines(
  p: string,
  offset: number,
  size: number,
  maxBytes: number,
): { buf: Buffer | null; sawEnd: boolean } {
  if (size <= offset) return { buf: null, sawEnd: true };
  const fd = openSync(p, 'r');
  try {
    let want = Math.min(size - offset, maxBytes);
    for (;;) {
      const buf = Buffer.alloc(want);
      const n = readSync(fd, buf, 0, want, offset);
      const nl = buf.subarray(0, n).lastIndexOf(0x0a);
      const sawEnd = offset + n >= size;
      if (nl !== -1) return { buf: buf.subarray(0, nl + 1), sawEnd };
      // A line longer than MAX_LINE_BYTES is skipped rather than wedging the file.
      if (want >= MAX_LINE_BYTES) return { buf: buf.subarray(0, n), sawEnd };
      if (sawEnd) return { buf: null, sawEnd };
      want = Math.min(size - offset, want * 4, MAX_LINE_BYTES);
    }
  } finally {
    closeSync(fd);
  }
}
