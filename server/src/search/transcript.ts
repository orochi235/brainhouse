/**
 * One transcript as the search reader shows it: the indexed events in order,
 * read back from the search database rather than re-parsed, so a hit's id
 * points straight at its row and every match is visible.
 */

import type { DB, DocRow, FileRow } from './db.js';
import type { Doc } from './extract.js';
import { type HighlightSpec, matchRanges } from './search.js';

/** Text beyond this is cut from rows without a match; a matching row is
 * always sent whole. */
const PREVIEW_CHARS = 600;

export interface TranscriptDoc {
  id: number;
  eventUuid: string;
  ts: number;
  kind: Doc['kind'];
  tool: string | null;
  isError: boolean;
  text: string;
  /** Characters cut from the end; fetch the row to see them. */
  truncated: number;
  ranges: Array<[number, number]>;
}

export interface Transcript {
  fileId: number;
  path: string;
  sessionId: string;
  agentId: string | null;
  cwd: string | null;
  docs: TranscriptDoc[];
}

export function readTranscript(db: DB, fileId: number, hl: HighlightSpec): Transcript | null {
  const f = db.prepare('SELECT * FROM files WHERE id = ?').get(fileId) as FileRow | undefined;
  if (!f) return null;
  const rows = db
    .prepare(
      'SELECT id, file_id, event_uuid, ts, kind, tool, is_error, text FROM docs WHERE file_id = ? ORDER BY ts, id',
    )
    .all(fileId) as DocRow[];
  return {
    fileId,
    path: f.path,
    sessionId: f.session_id,
    agentId: f.agent_id,
    cwd: f.cwd,
    docs: rows.map((r) => {
      const ranges = hl.terms.length || hl.regex ? matchRanges(r.text, hl) : [];
      const cut = ranges.length === 0 && r.text.length > PREVIEW_CHARS;
      return {
        id: r.id,
        eventUuid: r.event_uuid,
        ts: r.ts,
        kind: r.kind,
        tool: r.tool,
        isError: r.is_error === 1,
        text: cut ? r.text.slice(0, PREVIEW_CHARS) : r.text,
        truncated: cut ? r.text.length - PREVIEW_CHARS : 0,
        ranges,
      };
    }),
  };
}

export function readDocText(db: DB, docId: number): string | null {
  const row = db.prepare('SELECT text FROM docs WHERE id = ?').get(docId) as
    | { text: string }
    | undefined;
  return row?.text ?? null;
}
