import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listTranscripts, type RootSpec } from './ingest.js';
import { makeSnippet, matchRanges } from './search.js';
import { SearchIndex } from './searchIndex.js';

let dir: string;
let root: RootSpec;
let idx: SearchIndex;
let n = 0;

const user = (text: string, ts = '2026-10-01T10:00:00Z', cwd = '/Users/x/src/brainhouse') =>
  JSON.stringify({
    type: 'user',
    uuid: `u${++n}`,
    timestamp: ts,
    cwd,
    message: { role: 'user', content: text },
  });
const assistant = (text: string, ts = '2026-10-01T10:00:01Z') =>
  JSON.stringify({
    type: 'assistant',
    uuid: `a${++n}`,
    timestamp: ts,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });
const bash = (id: string, command: string, ts = '2026-10-01T10:00:02Z') =>
  JSON.stringify({
    type: 'assistant',
    uuid: `t${++n}`,
    timestamp: ts,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }],
    },
  });
const result = (id: string, content: string, isError = false, ts = '2026-10-01T10:00:03Z') =>
  JSON.stringify({
    type: 'user',
    uuid: `r${++n}`,
    timestamp: ts,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }],
    },
  });

function transcript(name: string, lines: string[], project = '-Users-x-src-brainhouse'): string {
  const p = path.join(dir, project, `${name}.jsonl`);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, lines.map((l) => `${l}\n`).join(''));
  return p;
}

function indexAll(maxBytes?: number) {
  for (const { path: p } of listTranscriptsSync()) while (!idx.ingest.step(p, root, maxBytes));
}
let files: string[] = [];
const listTranscriptsSync = () => files.map((p) => ({ path: p, root }));

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'bh-search-'));
  root = { path: dir, account: 'MSB' };
  idx = new SearchIndex(path.join(dir, 'search.db'));
  files = [];
});
afterEach(() => {
  idx.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('indexing', () => {
  it('finds a term in each kind of event', () => {
    files.push(
      transcript('s1', [
        user('why does spawn fail EBADF'),
        assistant('the fd table is full'),
        bash('tu1', 'lsof -p 4411 | wc -l'),
        result('tu1', 'Error: spawn EBADF at ChildProcess', true),
      ]),
    );
    indexAll();
    const r = idx.query('ebadf');
    expect(r.totalSessions).toBe(1);
    expect(r.totalHits).toBe(2);
    expect(r.groups[0]?.hits.map((h) => h.kind)).toEqual(['user_text', 'tool_result']);
    expect(r.groups[0]?.hits[1]).toMatchObject({ tool: 'Bash', isError: true });
    expect(r.groups[0]?.cwd).toBe('/Users/x/src/brainhouse');
    expect(r.groups[0]?.account).toBe('MSB');
  });

  it('indexes only appended lines, and holds a partial trailing line', () => {
    const p = transcript('s1', [user('first message alpha')]);
    files.push(p);
    indexAll();
    appendFileSync(p, `${user('second message bravo')}\n${user('third charlie').slice(0, 20)}`);
    expect(idx.ingest.needsWork(p)).toBe(true);
    indexAll();
    expect(idx.query('bravo').totalHits).toBe(1);
    expect(idx.query('alpha').totalHits).toBe(1);
    expect(idx.query('charlie').totalHits).toBe(0);
    appendFileSync(p, `${user('third charlie').slice(20)}\n`);
    indexAll();
    expect(idx.query('charlie').totalHits).toBe(1);
    expect(idx.stats().docs).toBe(3);
  });

  it('reads a big file in chunks and records the stat only when caught up', () => {
    const lines = Array.from({ length: 200 }, (_, i) => user(`line number ${i} padding padding`));
    const p = transcript('big', lines);
    files.push(p);
    expect(idx.ingest.step(p, root, 1024)).toBe(false);
    expect(idx.ingest.needsWork(p)).toBe(true);
    while (!idx.ingest.step(p, root, 1024));
    expect(idx.ingest.needsWork(p)).toBe(false);
    expect(idx.stats().docs).toBe(200);
  });

  it('reindexes a truncated file from the start', () => {
    const p = transcript('s1', [user('old content delta'), user('more old content')]);
    files.push(p);
    indexAll();
    truncateSync(p, 0);
    appendFileSync(p, `${user('new echo')}\n`);
    indexAll();
    expect(idx.query('delta').totalHits).toBe(0);
    expect(idx.query('echo').totalHits).toBe(1);
  });

  it('prunes files that are gone', () => {
    const keep = transcript('s1', [user('kept foxtrot')]);
    const gone = transcript('s2', [user('gone foxtrot')]);
    files.push(keep, gone);
    indexAll();
    expect(idx.ingest.prune(new Set([keep]))).toBe(1);
    expect(idx.query('foxtrot').totalSessions).toBe(1);
  });

  it('labels subagent transcripts with their parent session', async () => {
    const p = path.join(dir, 'proj', 'parent-1', 'subagents', 'agent-abc.jsonl');
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, `${user('subagent golf')}\n`);
    const listed = await listTranscripts([root]);
    expect(listed.map((l) => l.path)).toEqual([p]);
    files.push(p);
    indexAll();
    expect(idx.query('golf').groups[0]).toMatchObject({ sessionId: 'parent-1', agentId: 'abc' });
  });

  it('rebuilds a database from an older schema version', () => {
    files.push(transcript('s1', [user('hotel')]));
    indexAll();
    const dbPath = path.join(dir, 'search.db');
    idx.close();
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const raw = new DatabaseSync(dbPath);
    raw.exec("UPDATE meta SET value = '0' WHERE key = 'schema_version'");
    raw.close();
    idx = new SearchIndex(dbPath);
    expect(idx.stats().docs).toBe(0);
  });
});

describe('querying', () => {
  beforeEach(() => {
    files.push(
      transcript('older', [
        user('tracker cold start', '2026-09-01T10:00:00Z'),
        bash('b1', 'npm test', '2026-09-01T10:00:01Z'),
        result('b1', 'FAIL tracker.test.ts', true, '2026-09-01T10:00:02Z'),
      ]),
      transcript(
        'newer',
        [
          user('tracker again, a&b 100%', '2026-10-05T10:00:00Z', '/Users/x/src/perch'),
          assistant('Tracker fixed', '2026-10-05T10:00:01Z'),
        ],
        '-Users-x-src-perch',
      ),
    );
    indexAll();
  });

  it('orders sessions by their latest hit', () => {
    const r = idx.query('tracker');
    expect(r.groups.map((g) => g.sessionId)).toEqual(['newer', 'older']);
    expect(r.totalHits).toBe(4);
  });

  it('requires every term', () => {
    expect(idx.query('tracker fixed').totalHits).toBe(1);
  });

  it('matches a phrase literally', () => {
    expect(idx.query('"cold start"').totalHits).toBe(1);
    expect(idx.query('"start cold"').totalHits).toBe(0);
  });

  it('confirms terms with LIKE wildcards in JS', () => {
    expect(idx.query('100%').totalHits).toBe(1);
    expect(idx.query('a&b').totalHits).toBe(1);
    expect(idx.query('10_%').totalHits).toBe(0);
  });

  it('filters by role, tool, project and time', () => {
    expect(idx.query('tracker role:out').totalHits).toBe(1);
    expect(idx.query('tracker is:error').totalHits).toBe(1);
    expect(idx.query('tool:bash').totalHits).toBe(2);
    expect(idx.query('tracker project:perch').groups.map((g) => g.sessionId)).toEqual(['newer']);
    expect(idx.query('tracker after:2026-10-01').groups.map((g) => g.sessionId)).toEqual(['newer']);
    expect(idx.query('tracker before:2026-10-01').groups.map((g) => g.sessionId)).toEqual([
      'older',
    ]);
    expect(idx.query('tracker account:msb').totalSessions).toBe(2);
    expect(idx.query('tracker account:pw').totalSessions).toBe(0);
  });

  it('runs a regex through its literals', () => {
    expect(idx.query('/track\\w+\\.test/').totalHits).toBe(1);
    expect(idx.query('/^Tracker/s').totalHits).toBe(1);
  });

  it('scans when no literal is long enough', () => {
    const r = idx.query('/a&b|fai/');
    expect(r.totalHits).toBe(2);
    expect(r.partial).toBeNull();
  });

  it('pages sessions', () => {
    const p1 = idx.query('tracker', { pageSessions: 1 });
    expect(p1.groups.map((g) => g.sessionId)).toEqual(['newer']);
    expect(p1.nextCursor).toBe('page:1');
    const p2 = idx.query('tracker', { pageSessions: 1, cursor: p1.nextCursor });
    expect(p2.groups.map((g) => g.sessionId)).toEqual(['older']);
    expect(p2.nextCursor).toBeNull();
  });

  it('caps hits per session but counts them all', () => {
    const r = idx.query('tracker', { hitsPerSession: 1 });
    expect(r.groups[0]?.hitCount).toBe(2);
    expect(r.groups[0]?.hits).toHaveLength(1);
  });

  it('returns nothing for an empty query and reports parse errors', () => {
    expect(idx.query('  ').groups).toEqual([]);
    expect(idx.query('/(/').errors[0]).toMatch(/bad regex/);
  });
});

describe('snippets', () => {
  it('centers on the first match and flattens whitespace', () => {
    const text = `${'x'.repeat(200)}\nneedle\there`;
    const ranges = matchRanges(text, { terms: ['needle'], regex: null });
    const s = makeSnippet(text, ranges);
    expect(s.clippedStart).toBe(true);
    const [a, b] = s.ranges[0] ?? [0, 0];
    expect(s.snippet.slice(a, b)).toBe('needle');
    expect(s.snippet).not.toMatch(/[\n\t]/);
  });

  it('merges overlapping term and regex matches', () => {
    expect(matchRanges('abcdef', { terms: ['abc'], regex: { source: 'cde', flags: 'i' } })).toEqual(
      [[0, 5]],
    );
  });
});
