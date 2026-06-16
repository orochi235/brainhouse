import { describe, expect, it } from 'vitest';
import { BackgroundIndexer } from './indexer.js';

function fakeDeps(files: string[]) {
  const written: string[] = [];
  return {
    written,
    deps: {
      takeFiles: () => files.splice(0, files.length),
      parseFile: async (p: string) => [
        { session_id: p.replace('.jsonl', ''), agent_id: null, uuid: p, parent_uuid: null,
          ts: '2020-01-01T00:00:00.000Z', cwd: '/tmp', kind: 'user_text', tags: [], payload: { text: 'x' } },
      ],
      summarize: (events: any[]) => ({ session_id: events[0].session_id }),
      write: (row: any) => { written.push(row.session_id); },
      batchSize: 2,
      intervalMs: 0,
    },
  };
}

describe('BackgroundIndexer', () => {
  it('drains all deferred files into summary writes', async () => {
    const { written, deps } = fakeDeps(['a.jsonl', 'b.jsonl', 'c.jsonl']);
    const ix = new BackgroundIndexer(deps as any);
    await ix.runToCompletion();
    expect(written.sort()).toEqual(['a', 'b', 'c']);
  });

  it('stop() halts further ticks', async () => {
    const { written, deps } = fakeDeps(['a.jsonl', 'b.jsonl', 'c.jsonl', 'd.jsonl']);
    const ix = new BackgroundIndexer({ ...deps, batchSize: 1, intervalMs: 5 } as any);
    const p = ix.runToCompletion();
    ix.stop();
    await p;
    expect(written.length).toBeLessThanOrEqual(2);
  });
});
