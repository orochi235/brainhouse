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

  close(): void {
    this.db.close();
  }
}
