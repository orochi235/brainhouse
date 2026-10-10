import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findRoots, initStore, run } from 'icehouse';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RootSpec } from './ingest.js';
import { enforceCap, planScan, stepFile } from './scan.js';
import { SearchIndex } from './searchIndex.js';
import { StoredTranscripts } from './stored.js';

const HOUR = 3_600_000;
const S1 = '11111111-2222-3333-4444-555555555555';
const S2 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

let home: string;
let storeDir: string;
let root: RootSpec;
let idx: SearchIndex;
let stored: StoredTranscripts;
let live: string[];
let n = 0;

const line = (text: string, ts: string) =>
  `${JSON.stringify({
    type: 'user',
    uuid: `u${++n}`,
    timestamp: ts,
    cwd: '/Users/x/src/brainhouse',
    message: { role: 'user', content: text },
  })}\n`;

/** A transcript under the home's `.claude/projects`, idle long enough for
 * icehouse to copy it. */
function transcript(session: string, body: string, project = 'proj'): string {
  const p = path.join(root.path, project, `${session}.jsonl`);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, body);
  const then = new Date(Date.now() - 2 * HOUR);
  utimesSync(p, then, then);
  live.push(p);
  return p;
}

function remove(p: string): void {
  rmSync(p);
  live = live.filter((l) => l !== p);
}

const archive = () => run({ roots: findRoots(home), store: initStore(storeDir) });
const never = () => false;
const rootOf = (p: string) => (p.startsWith(`${root.path}/`) ? root.path : null);

/** One scan and everything it queues, as the worker runs them. */
async function scan(overCap: () => boolean = never, maxBytes = 1024 * 1024): Promise<void> {
  await stored.refresh();
  const queue = planScan(idx.ingest, live, stored, rootOf);
  for (const p of queue) while (!stepFile(idx.ingest, stored, p, root, maxBytes, overCap));
  enforceCap(idx.ingest, stored, overCap);
}

const hits = (q: string) => idx.query(q).totalHits;

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'bh-stored-'));
  storeDir = path.join(home, 'store');
  mkdirSync(storeDir);
  root = { path: path.join(home, '.claude', 'projects'), account: 'CC' };
  mkdirSync(root.path, { recursive: true });
  idx = new SearchIndex(':memory:');
  stored = new StoredTranscripts({ dir: storeDir, home });
  live = [];
});
afterEach(() => {
  idx.close();
  rmSync(home, { recursive: true, force: true });
});

describe('a transcript Claude Code has deleted', () => {
  it('stays searchable while the store holds it, and is marked stored', async () => {
    const p = transcript(S1, line('find the heron', '2026-09-01T10:00:00Z'));
    await archive();
    await scan();
    expect(idx.query('heron').groups[0]?.stored).toBe(false);

    remove(p);
    await scan();
    expect(hits('heron')).toBe(1);
    expect(idx.query('heron').groups[0]?.stored).toBe(true);
  });

  it('is dropped when the store never copied it', async () => {
    const p = transcript(S1, line('find the heron', '2026-09-01T10:00:00Z'));
    initStore(storeDir);
    await scan();
    remove(p);
    await scan();
    expect(stored.state).toBe('open');
    expect(hits('heron')).toBe(0);
  });

  it('is dropped when icehouse is not set up', async () => {
    stored = new StoredTranscripts({ dir: path.join(home, 'nowhere'), home });
    const p = transcript(S1, line('find the heron', '2026-09-01T10:00:00Z'));
    await scan();
    remove(p);
    await scan();
    expect(stored.state).toBe('none');
    expect(hits('heron')).toBe(0);
  });

  it('is kept while the store cannot be reached', async () => {
    const unplugged = path.join(home, 'unplugged');
    symlinkSync(path.join(home, 'no-such-drive'), unplugged);
    stored = new StoredTranscripts({ dir: unplugged, home });
    const p = transcript(S1, line('find the heron', '2026-09-01T10:00:00Z'));
    await scan();
    remove(p);
    await scan();
    expect(stored.state).toBe('unreachable');
    expect(hits('heron')).toBe(1);
  });

  it('is dropped once its root is no longer watched', async () => {
    const p = transcript(S1, line('find the heron', '2026-09-01T10:00:00Z'));
    await archive();
    await scan();
    remove(p);
    await stored.refresh();
    planScan(idx.ingest, live, stored, () => null);
    expect(hits('heron')).toBe(0);
  });
});

describe('a session whose files moved to another project directory', () => {
  it('is one result, from the live file, while the store holds the old path', async () => {
    const before = transcript(S1, line('find the heron', '2026-09-01T10:00:00Z'));
    await archive();
    await scan();
    remove(before);
    transcript(S1, line('find the heron', '2026-09-01T10:00:00Z'), 'proj-moved');
    await scan();
    expect(hits('heron')).toBe(1);
    expect(idx.query('heron').groups[0]?.stored).toBe(false);
  });

  it('is one result once deleted, though the store holds both paths', async () => {
    const before = transcript(S1, line('find the heron', '2026-09-01T10:00:00Z'));
    await archive();
    remove(before);
    const after = transcript(
      S1,
      line('find the heron', '2026-09-01T10:00:00Z') +
        line('and the egret', '2026-09-01T10:01:00Z'),
      'proj-moved',
    );
    await archive();
    remove(after);
    await scan();
    expect(hits('heron')).toBe(1);
    expect(hits('egret')).toBe(1);
  });
});

describe('an index rebuilt from nothing', () => {
  it('reads a deleted transcript back from the store', async () => {
    const p = transcript(
      S1,
      line('find the heron', '2026-09-01T10:00:00Z') +
        line('and the egret', '2026-09-01T10:01:00Z'),
    );
    await archive();
    remove(p);
    await scan();
    expect(hits('heron')).toBe(1);
    expect(hits('egret')).toBe(1);
    const [group] = idx.query('egret').groups;
    expect(group).toMatchObject({ sessionId: S1, account: 'CC', stored: true });
  });

  it('reads a stored transcript over several steps, and only once', async () => {
    const body = Array.from({ length: 40 }, (_, i) =>
      line(`entry ${i} ${'x'.repeat(200)}`, '2026-09-01T10:00:00Z'),
    ).join('');
    const p = transcript(S1, body);
    await archive();
    remove(p);

    await stored.refresh();
    const [queued] = planScan(idx.ingest, live, stored, rootOf);
    expect(queued).toBe(p);
    let steps = 0;
    while (!stepFile(idx.ingest, stored, p, root, 1024, never)) steps++;
    expect(steps).toBeGreaterThan(3);
    expect(hits('entry')).toBe(40);

    expect(planScan(idx.ingest, live, stored, rootOf)).toEqual([]);
  });

  it('indexes the last line of a stored transcript that ends without a newline', async () => {
    const p = transcript(S1, line('find the heron', '2026-09-01T10:00:00Z').trimEnd());
    await archive();
    remove(p);
    await scan();
    expect(hits('heron')).toBe(1);
    expect(planScan(idx.ingest, live, stored, rootOf)).toEqual([]);
  });
});

describe('the index cap', () => {
  it('takes the oldest stored session out of search first, and never a live one', async () => {
    const old = transcript(S1, line('old heron', '2026-08-01T10:00:00Z'));
    const newer = transcript(S2, line('newer heron', '2026-09-01T10:00:00Z'));
    const kept = transcript(
      '99999999-2222-3333-4444-555555555555',
      line('live heron', '2026-07-01T10:00:00Z'),
    );
    await archive();
    await scan();
    remove(old);
    remove(newer);

    // Over the cap until one session has gone.
    let over = 1;
    await scan(() => over-- > 0);
    expect(idx.query('heron').groups.map((g) => g.sessionId)).toEqual([
      S2,
      path.basename(kept, '.jsonl'),
    ]);
  });

  it('does not read a shelved session back in on the next scan', async () => {
    const p = transcript(S1, line('old heron', '2026-08-01T10:00:00Z'));
    await archive();
    await scan();
    remove(p);
    let over = 1;
    await scan(() => over-- > 0);
    expect(hits('heron')).toBe(0);
    await scan();
    expect(hits('heron')).toBe(0);
  });

  it('skips stored transcripts during a rebuild that is already over', async () => {
    const p = transcript(S1, line('old heron', '2026-08-01T10:00:00Z'));
    await archive();
    remove(p);
    await scan(() => true);
    expect(hits('heron')).toBe(0);
    await scan();
    expect(hits('heron')).toBe(0);
  });

  it('frees space in the database when a session is shelved', async () => {
    const body = Array.from({ length: 400 }, (_, i) =>
      line(`entry ${i} ${Math.random().toString(36).repeat(40)}`, '2026-09-01T10:00:00Z'),
    ).join('');
    const p = transcript(S1, body);
    await archive();
    await scan();
    remove(p);
    const before = idx.usedBytes();
    let over = 1;
    await scan(() => over-- > 0);
    expect(idx.usedBytes()).toBeLessThan(before / 2);
  });
});
