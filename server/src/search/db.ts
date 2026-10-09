/**
 * The search database: schema, opening, and row shapes. The index is derived
 * entirely from the transcripts, so a schema change rebuilds it from nothing
 * rather than migrating.
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Doc } from './extract.js';

const require = createRequire(import.meta.url);
// biome-ignore lint/suspicious/noExplicitAny: node:sqlite types are minimal under the createRequire path
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: any };
// biome-ignore lint/suspicious/noExplicitAny: same as above
export type DB = any;

export const SEARCH_SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL,
  agent_id TEXT,
  account TEXT,
  cwd TEXT,
  repo_root TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  mtime REAL NOT NULL DEFAULT 0,
  offset INTEGER NOT NULL DEFAULT 0,
  first_ts REAL,
  last_ts REAL
);
CREATE TABLE IF NOT EXISTS docs (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL,
  event_uuid TEXT NOT NULL,
  ts REAL NOT NULL,
  kind TEXT NOT NULL,
  tool TEXT,
  tuid TEXT,
  is_error INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS docs_file_ts ON docs (file_id, ts);
CREATE INDEX IF NOT EXISTS docs_ts ON docs (ts);
CREATE INDEX IF NOT EXISTS docs_tuid ON docs (file_id, tuid) WHERE tuid IS NOT NULL;
CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
  text, content='docs', content_rowid='id', tokenize='trigram', detail='none'
);
`;

export interface FileRow {
  id: number;
  path: string;
  session_id: string;
  agent_id: string | null;
  account: string | null;
  cwd: string | null;
  repo_root: string | null;
  size: number;
  mtime: number;
  offset: number;
  first_ts: number | null;
  last_ts: number | null;
}

export interface DocRow {
  id: number;
  file_id: number;
  event_uuid: string;
  ts: number;
  kind: Doc['kind'];
  tool: string | null;
  is_error: number;
  text: string;
}

export function openSearchDb(dbPath: string): DB {
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  let db = new DatabaseSync(dbPath);
  if (dbPath !== ':memory:' && storedVersion(db) !== String(SEARCH_SCHEMA_VERSION)) {
    db.close();
    for (const sfx of ['', '-wal', '-shm']) rmSync(`${dbPath}${sfx}`, { force: true });
    db = new DatabaseSync(dbPath);
  }
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(
    String(SEARCH_SCHEMA_VERSION),
  );
  return db;
}

/** The stored schema version; undefined for a fresh or foreign file, which
 * the caller treats as a mismatch only when it already holds tables. */
function storedVersion(db: DB): string | undefined {
  const hasTables = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'docs'").get();
  if (!hasTables) return String(SEARCH_SCHEMA_VERSION);
  try {
    return db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value;
  } catch {
    return undefined;
  }
}

export function parseTs(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? null : t / 1000;
}
