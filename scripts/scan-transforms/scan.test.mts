import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scanLines } from './scan.mts';

const fixture = readFileSync(
  fileURLToPath(new URL('./__fixtures__/sample.jsonl', import.meta.url)),
  'utf8',
);
const lines = fixture.split('\n').filter((l) => l.trim().length > 0);

describe('scanLines', () => {
  const r = scanLines(lines);

  it('counts a malformed line without aborting', () => {
    expect(r.stats.malformedLines).toBe(1);
  });

  it('tallies the matching selector with its version', () => {
    const todo = r.perSelector['tool-use.todo-write'];
    expect(todo.count).toBe(1);
    expect(todo.maxVersion).toBe('2.1.9');
  });

  it('includes every registry selector, even count 0', () => {
    expect(r.perSelector['tool-use.ask-user-question'].count).toBe(0);
  });

  it('buckets the novel tool into a cluster with a draft selector', () => {
    const c = r.clusters.find((c) => c.shapeKey === 'tool_use|BrandNewTool');
    expect(c).toBeDefined();
    expect(c?.count).toBe(1);
    expect(c?.draftSelector).toContain('BrandNewTool');
  });

  it('tracks the max version seen across all lines', () => {
    expect(r.maxVersionSeen).toBe('2.1.112');
  });

  it('clusters an event even though a broad .any selector matched it', () => {
    // BrandNewTool matches the broad `tool-use.any` selector but no name-specific one,
    // so it must still surface as a cluster.
    expect(r.perSelector['tool-use.any'].count).toBeGreaterThanOrEqual(2);
    expect(r.clusters.find((c) => c.shapeKey === 'tool_use|BrandNewTool')).toBeDefined();
  });
});
