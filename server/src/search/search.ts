/**
 * Runs a parsed query against the search database: narrows candidates through
 * the trigram index where the query has a literal of 3+ characters, confirms
 * each in JS where SQL `LIKE` can't be trusted, and groups hits by transcript.
 */

import type { DB, DocRow, FileRow } from './db.js';
import type { Doc } from './extract.js';
import { type ParsedQuery, parseQuery, type Role, requiredLiterals } from './query.js';

export interface SearchHit {
  docId: number;
  eventUuid: string;
  ts: number;
  kind: Doc['kind'];
  tool: string | null;
  isError: boolean;
  /** Whitespace flattened to spaces, so `ranges` index it directly. */
  snippet: string;
  clippedStart: boolean;
  clippedEnd: boolean;
  ranges: Array<[number, number]>;
}

export interface SearchGroup {
  fileId: number;
  sessionId: string;
  agentId: string | null;
  account: string | null;
  cwd: string | null;
  repoRoot: string | null;
  firstTs: number | null;
  lastTs: number | null;
  latestHitTs: number;
  hitCount: number;
  hits: SearchHit[];
}

/** What the client needs to highlight matches itself, so it never parses the
 * query a second way. Terms are lowercased. */
export interface HighlightSpec {
  terms: string[];
  regex: { source: string; flags: string } | null;
}

export interface SearchResult {
  groups: SearchGroup[];
  totalSessions: number;
  totalHits: number;
  /** Pass back as `cursor` for the next page; null on the last. */
  nextCursor: string | null;
  /** A scan that ran out of budget: the oldest event time it reached. */
  partial: { scannedBackTo: number } | null;
  /** An indexed query that ran past its budget and was abandoned. */
  tooBroad: boolean;
  errors: string[];
  highlight: HighlightSpec;
  elapsedMs: number;
}

export interface QueryOptions {
  cursor?: string | null;
  pageSessions?: number;
  hitsPerSession?: number;
  budgetMs?: number;
  now?: number;
}

const DEFAULT_PAGE = 50;
const DEFAULT_HITS = 20;
const INDEXED_BUDGET_MS = 3000;
const SCAN_BUDGET_MS = 200;
const SNIPPET_BEFORE = 80;
const SNIPPET_LEN = 320;

const ROLE_SQL: Record<Role, string> = {
  you: "d.kind = 'user_text'",
  ai: "d.kind = 'assistant_text'",
  thinking: "d.kind = 'thinking'",
  tool: "d.kind = 'tool_use'",
  out: "d.kind = 'tool_result'",
  error: "(d.kind = 'tool_result' AND d.is_error = 1)",
};

const BUDGET_MESSAGE = 'bh_search_budget_exceeded';

/** Every match of the query's text predicates in `text`, merged and sorted. */
export function matchRanges(text: string, hl: HighlightSpec): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const lower = text.toLowerCase();
  for (const term of hl.terms) {
    if (!term) continue;
    for (let i = lower.indexOf(term); i !== -1; i = lower.indexOf(term, i + term.length)) {
      out.push([i, i + term.length]);
    }
  }
  if (hl.regex) {
    const re = new RegExp(hl.regex.source, `${hl.regex.flags.replace('g', '')}g`);
    for (const m of text.matchAll(re)) {
      if (m[0].length === 0) continue;
      out.push([m.index, m.index + m[0].length]);
      if (out.length > 1000) break;
    }
  }
  out.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const r of out) {
    const last = merged.at(-1);
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

export function makeSnippet(
  text: string,
  ranges: Array<[number, number]>,
): Pick<SearchHit, 'snippet' | 'clippedStart' | 'clippedEnd' | 'ranges'> {
  const first = ranges[0]?.[0] ?? 0;
  const start = Math.max(0, first - SNIPPET_BEFORE);
  const end = Math.min(text.length, start + SNIPPET_LEN);
  return {
    snippet: text.slice(start, end).replace(/\s/g, ' '),
    clippedStart: start > 0,
    clippedEnd: end < text.length,
    ranges: ranges
      .filter(([a]) => a < end)
      .map(([a, b]) => [a - start, Math.min(b, end) - start] as [number, number]),
  };
}

/** Every term (case-insensitive) and the regex must match. */
function makeVerifier(pq: ParsedQuery, terms: string[]): (text: string) => boolean {
  const re = pq.regex;
  return (text) => {
    if (terms.length) {
      const lower = text.toLowerCase();
      for (const t of terms) if (!lower.includes(t)) return false;
    }
    return re ? re.test(text) : true;
  };
}

export class Searcher {
  /** Read by the bh_verify SQL function: past it, the running query aborts. */
  private deadline = Number.POSITIVE_INFINITY;
  private verifier: ((text: string) => boolean) | null = null;

  constructor(private readonly db: DB) {
    db.function('bh_verify', { deterministic: false }, (text: unknown) => {
      if (Date.now() > this.deadline) throw new Error(BUDGET_MESSAGE);
      return this.verifier && typeof text === 'string' && this.verifier(text) ? 1 : 0;
    });
  }

  query(q: string, opts: QueryOptions = {}): SearchResult {
    const t0 = Date.now();
    const pq = parseQuery(q, opts.now);
    const highlight: HighlightSpec = {
      terms: pq.terms.map((t) => t.toLowerCase()),
      regex: pq.regex ? { source: pq.regex.source, flags: pq.regex.flags } : null,
    };
    const done = (r: Partial<SearchResult>): SearchResult => ({
      groups: [],
      totalSessions: 0,
      totalHits: 0,
      nextCursor: null,
      partial: null,
      tooBroad: false,
      errors: pq.errors,
      highlight,
      ...r,
      elapsedMs: Date.now() - t0,
    });
    const hasText = pq.terms.length > 0 || pq.regex !== null;
    const hasFilter =
      pq.projects.length + pq.accounts.length + pq.roles.length + pq.tools.length > 0 ||
      pq.after !== null ||
      pq.before !== null;
    if (!hasText && !hasFilter) return done({});

    const likes = [
      ...pq.terms.filter((t) => t.length >= 3),
      ...(pq.regex ? requiredLiterals(pq.regex.source) : []),
    ];
    // SQL LIKE is exact for ASCII terms with no wildcard characters; anything
    // else gets confirmed in JS.
    const verify =
      pq.regex !== null ||
      pq.terms.some((t) => t.length < 3 || /[%_\\]/.test(t) || /[^\x20-\x7e]/.test(t));
    const verifier = makeVerifier(pq, highlight.terms);
    if (hasText && likes.length === 0) return done(this.scan(pq, verifier, highlight, opts, t0));

    this.verifier = verify ? verifier : null;
    this.deadline = t0 + (opts.budgetMs ?? INDEXED_BUDGET_MS);
    try {
      return done(this.indexed(pq, likes, verify, highlight, opts));
    } catch (err) {
      if (String(err).includes(BUDGET_MESSAGE)) return done({ tooBroad: true });
      throw err;
    } finally {
      this.deadline = Number.POSITIVE_INFINITY;
      this.verifier = null;
    }
  }

  private filterSql(pq: ParsedQuery): { sql: string[]; params: unknown[] } {
    const sql: string[] = [];
    const params: unknown[] = [];
    if (pq.projects.length) {
      // A repo's leaf name, or any part of the session's cwd.
      sql.push(
        `(${pq.projects
          .map(() => "(f.repo_root LIKE '%/' || ? OR f.cwd LIKE '%' || ? || '%')")
          .join(' OR ')})`,
      );
      for (const p of pq.projects) params.push(p, p);
    }
    if (pq.accounts.length) {
      sql.push(`UPPER(f.account) IN (${pq.accounts.map(() => '?').join(',')})`);
      params.push(...pq.accounts);
    }
    if (pq.roles.length) sql.push(`(${pq.roles.map((r) => ROLE_SQL[r]).join(' OR ')})`);
    if (pq.tools.length) {
      sql.push(`(${pq.tools.map(() => 'd.tool = ? COLLATE NOCASE').join(' OR ')})`);
      params.push(...pq.tools);
    }
    if (pq.after !== null) {
      sql.push('d.ts >= ?');
      params.push(pq.after);
    }
    if (pq.before !== null) {
      sql.push('d.ts < ?');
      params.push(pq.before);
    }
    return { sql, params };
  }

  private indexed(
    pq: ParsedQuery,
    likes: string[],
    verify: boolean,
    hl: HighlightSpec,
    opts: QueryOptions,
  ): Partial<SearchResult> {
    const page = opts.pageSessions ?? DEFAULT_PAGE;
    const f = this.filterSql(pq);
    const where = [...likes.map(() => 'docs_fts.text LIKE ?'), ...f.sql];
    if (verify) where.push('bh_verify(d.text)');
    const from = likes.length
      ? 'docs_fts JOIN docs d ON d.id = docs_fts.rowid JOIN files f ON f.id = d.file_id'
      : 'docs d JOIN files f ON f.id = d.file_id';
    const params = [...likes.map((l) => `%${l}%`), ...f.params];

    // Match once into a temp table, then group and pick hits from it: joining
    // the trigram LIKE a second time makes SQLite re-run it per session.
    this.db.exec('DROP TABLE IF EXISTS temp.hits');
    this.db
      .prepare(
        `CREATE TEMP TABLE hits AS SELECT d.id, d.file_id, d.ts FROM ${from}
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`,
      )
      .run(...params);
    const groups = this.db
      .prepare('SELECT file_id fid, MAX(ts) latest, COUNT(*) n FROM temp.hits GROUP BY file_id')
      .all() as Array<{ fid: number; latest: number; n: number }>;
    groups.sort((a, b) => b.latest - a.latest);
    const start = opts.cursor?.startsWith('page:') ? Number(opts.cursor.slice(5)) || 0 : 0;
    const pageGroups = groups.slice(start, start + page);

    let rows: DocRow[] = [];
    if (pageGroups.length) {
      const ids = pageGroups.map((g) => g.fid);
      rows = this.db
        .prepare(
          `SELECT d.id, d.file_id, d.event_uuid, d.ts, d.kind, d.tool, d.is_error, d.text
           FROM (
             SELECT id, file_id, ROW_NUMBER() OVER (PARTITION BY file_id ORDER BY ts, id) rn
             FROM temp.hits WHERE file_id IN (${ids.map(() => '?').join(',')})
           ) h JOIN docs d ON d.id = h.id
           WHERE h.rn <= ? ORDER BY h.file_id, h.rn`,
        )
        .all(...ids, opts.hitsPerSession ?? DEFAULT_HITS) as DocRow[];
    }
    this.db.exec('DROP TABLE IF EXISTS temp.hits');
    const byFile = new Map<number, DocRow[]>();
    for (const r of rows) {
      const list = byFile.get(r.file_id) ?? [];
      list.push(r);
      byFile.set(r.file_id, list);
    }
    return {
      groups: pageGroups.map((g) =>
        this.toGroup(g.fid, g.latest, g.n, byFile.get(g.fid) ?? [], hl),
      ),
      totalSessions: groups.length,
      totalHits: groups.reduce((s, g) => s + g.n, 0),
      nextCursor: start + page < groups.length ? `page:${start + page}` : null,
    };
  }

  /** A text predicate the index can't narrow (every literal under 3
   * characters): walk events newest first, confirming in JS, until the budget
   * runs out. The cursor `scan:<ts>` resumes below that time. */
  private scan(
    pq: ParsedQuery,
    verify: (text: string) => boolean,
    hl: HighlightSpec,
    opts: QueryOptions,
    t0: number,
  ): Partial<SearchResult> {
    const deadline = t0 + (opts.budgetMs ?? SCAN_BUDGET_MS);
    const f = this.filterSql(pq);
    if (opts.cursor?.startsWith('scan:')) {
      f.sql.push('d.ts < ?');
      f.params.push(Number(opts.cursor.slice(5)));
    }
    const stmt = this.db.prepare(
      `SELECT d.id, d.file_id, d.event_uuid, d.ts, d.kind, d.tool, d.is_error, d.text
       FROM docs d JOIN files f ON f.id = d.file_id
       ${f.sql.length ? `WHERE ${f.sql.join(' AND ')}` : ''}
       ORDER BY d.ts DESC`,
    );
    const groups = new Map<number, { latest: number; n: number; rows: DocRow[] }>();
    const perSession = opts.hitsPerSession ?? DEFAULT_HITS;
    let lastTs: number | null = null;
    let finished = true;
    let i = 0;
    for (const r of stmt.iterate(...f.params) as Iterable<DocRow>) {
      // Stop only between distinct timestamps, so resuming with `ts <` never
      // skips a row that shared the last one's time.
      if ((++i & 255) === 0 && Date.now() > deadline && r.ts !== lastTs) {
        finished = false;
        break;
      }
      lastTs = r.ts;
      if (!verify(r.text)) continue;
      const g = groups.get(r.file_id) ?? { latest: r.ts, n: 0, rows: [] };
      g.n++;
      g.rows.push(r);
      groups.set(r.file_id, g);
    }
    const ordered = [...groups.entries()].sort((a, b) => b[1].latest - a[1].latest);
    const more = !finished && lastTs !== null;
    return {
      groups: ordered.map(([fid, g]) =>
        this.toGroup(fid, g.latest, g.n, g.rows.reverse().slice(0, perSession), hl),
      ),
      totalSessions: ordered.length,
      totalHits: ordered.reduce((s, [, g]) => s + g.n, 0),
      nextCursor: more ? `scan:${lastTs}` : null,
      partial: more ? { scannedBackTo: lastTs as number } : null,
    };
  }

  private toGroup(
    fid: number,
    latest: number,
    n: number,
    rows: DocRow[],
    hl: HighlightSpec,
  ): SearchGroup {
    const f = this.db.prepare('SELECT * FROM files WHERE id = ?').get(fid) as FileRow;
    return {
      fileId: fid,
      sessionId: f.session_id,
      agentId: f.agent_id,
      account: f.account,
      cwd: f.cwd,
      repoRoot: f.repo_root,
      firstTs: f.first_ts,
      lastTs: f.last_ts,
      latestHitTs: latest,
      hitCount: n,
      hits: rows.map((r) => ({
        docId: r.id,
        eventUuid: r.event_uuid,
        ts: r.ts,
        kind: r.kind,
        tool: r.tool,
        isError: r.is_error === 1,
        ...makeSnippet(r.text, matchRanges(r.text, hl)),
      })),
    };
  }
}
