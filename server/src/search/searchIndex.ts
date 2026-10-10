/**
 * The transcript search index: one database, written by an Ingester and read
 * by a Searcher. Synchronous; the search worker owns the only instance.
 * Design: docs/superpowers/specs/2026-10-08-transcript-search-design.md.
 */

import { type DB, openSearchDb } from './db.js';
import { Ingester } from './ingest.js';
import { type HighlightSpec, type QueryOptions, Searcher, type SearchResult } from './search.js';
import { readDocText, readTranscript, type Transcript } from './transcript.js';

export class SearchIndex {
  private readonly db: DB;
  readonly ingest: Ingester;
  private readonly searcher: Searcher;

  constructor(dbPath: string) {
    this.db = openSearchDb(dbPath);
    this.ingest = new Ingester(this.db);
    this.searcher = new Searcher(this.db);
  }

  query(q: string, opts?: QueryOptions): SearchResult {
    return this.searcher.query(q, opts);
  }

  transcript(fileId: number, hl: HighlightSpec): Transcript | null {
    return readTranscript(this.db, fileId, hl);
  }

  docText(docId: number): string | null {
    return readDocText(this.db, docId);
  }

  stats(): { files: number; docs: number } {
    const n = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return { files: n('SELECT COUNT(*) n FROM files'), docs: n('SELECT COUNT(*) n FROM docs') };
  }

  /** Bytes of the database in use. Deleting rows frees pages without
   * shrinking the file, so the file's own size would never come back down. */
  usedBytes(): number {
    const n = (pragma: string) =>
      Number(Object.values(this.db.prepare(`PRAGMA ${pragma}`).get() as object)[0]);
    return (n('page_count') - n('freelist_count')) * n('page_size');
  }

  close(): void {
    this.db.close();
  }
}
