import { describe, expect, it } from 'vitest';
import { allocateSlots } from './slotAllocator.ts';

type C = Parameters<typeof allocateSlots>[0][number];

const c = (id: string, status: C['status'], cwd: string | null, last: number): C => ({
  id,
  status,
  cwd,
  last_event_at: last,
});

describe('allocateSlots', () => {
  it('pinned panels always claim a slot, overriding the cap', () => {
    const cands = [
      c('A', 'mini', '/Users/mike/src/brainhouse', 1),
      c('B', 'mini', '/Users/mike/src/brainhouse', 2),
      c('C', 'mini', '/Users/mike/src/brainhouse', 3),
      c('D', 'mini', '/Users/mike/src/brainhouse', 4),
      c('E', 'mini', '/Users/mike/src/brainhouse', 5),
    ];
    const { primary, overflow } = allocateSlots(cands, new Set(['A', 'B', 'C', 'D', 'E']), 2);
    expect(primary).toEqual(new Set(['A', 'B', 'C', 'D', 'E']));
    expect(overflow.size).toBe(0);
  });

  it('live unpinned panels always claim a slot', () => {
    const cands = [
      c('A', 'live', '/Users/mike/src/brainhouse', 1),
      c('B', 'live', '/Users/mike/src/brainhouse', 2),
      c('C', 'live', '/Users/mike/src/brainhouse', 3),
    ];
    const { primary } = allocateSlots(cands, new Set(), 1);
    expect(primary).toEqual(new Set(['A', 'B', 'C']));
  });

  it('fills empty slots from closed panels when no live work', () => {
    const cands = [
      c('A', 'mini', '/Users/mike/src/brainhouse', 100),
      c('B', 'done', '/Users/mike/src/brainhouse', 200),
      c('C', 'mini', '/Users/mike/src/brainhouse', 50),
    ];
    const { primary, overflow } = allocateSlots(cands, new Set(), 2);
    // Most-recent two by last_event_at.
    expect(primary).toEqual(new Set(['B', 'A']));
    expect(overflow).toEqual(new Set(['C']));
  });

  it('rounds-robin across repos before doubling up on one', () => {
    // 4 slots, 2 repos with 3 panels each — expect 2 from each repo.
    const bh = (id: string, last: number) =>
      c(id, 'mini', '/Users/mike/src/brainhouse', last);
    const we = (id: string, last: number) => c(id, 'mini', '/Users/mike/src/weasel', last);
    const cands = [bh('BH1', 100), bh('BH2', 90), bh('BH3', 80), we('WE1', 95), we('WE2', 85), we('WE3', 75)];
    const { primary } = allocateSlots(cands, new Set(), 4);
    expect(primary).toEqual(new Set(['BH1', 'WE1', 'BH2', 'WE2']));
  });

  it('falls back to same-repo when only one repo has activity', () => {
    const bh = (id: string, last: number) =>
      c(id, 'mini', '/Users/mike/src/brainhouse', last);
    const cands = [bh('A', 100), bh('B', 90), bh('C', 80), bh('D', 70)];
    const { primary } = allocateSlots(cands, new Set(), 3);
    expect(primary).toEqual(new Set(['A', 'B', 'C']));
  });

  it('collapses worktrees of the same repo under one key', () => {
    // Two worktrees of brainhouse + one weasel. Round-robin should see
    // brainhouse as a single bucket — first pass: 1 brainhouse + 1 weasel.
    const main = c('M', 'mini', '/Users/mike/src/brainhouse', 100);
    const wt = c(
      'W',
      'mini',
      '/Users/mike/src/brainhouse/.claude/worktrees/foo',
      99,
    );
    const we = c('X', 'mini', '/Users/mike/src/weasel', 50);
    const { primary } = allocateSlots([main, wt, we], new Set(), 2);
    expect(primary).toEqual(new Set(['M', 'X']));
  });

  it('most-recent repo wins ties in the round-robin order', () => {
    // brainhouse most-recent panel is older than weasel's; weasel wins
    // pass-1 priority.
    const bh = c('BH', 'mini', '/Users/mike/src/brainhouse', 50);
    const we = c('WE', 'mini', '/Users/mike/src/weasel', 100);
    const { primary } = allocateSlots([bh, we], new Set(), 1);
    expect(primary).toEqual(new Set(['WE']));
  });

  it('slotCount=0 disables the allocator — only pinned + live in primary', () => {
    const cands = [
      c('A', 'live', '/x', 1),
      c('B', 'mini', '/x', 2),
      c('C', 'done', '/x', 3),
    ];
    const { primary, overflow } = allocateSlots(cands, new Set(['B']), 0);
    expect(primary).toEqual(new Set(['A', 'B']));
    expect(overflow).toEqual(new Set(['C']));
  });

  it('live panels do not consume slot budget for closed-panel fill', () => {
    // 2 live, slotCount=4 → all 2 live in primary, plus 2 from closed pool.
    const cands = [
      c('L1', 'live', '/Users/mike/src/brainhouse', 100),
      c('L2', 'live', '/Users/mike/src/brainhouse', 99),
      c('M1', 'mini', '/Users/mike/src/brainhouse', 90),
      c('M2', 'mini', '/Users/mike/src/brainhouse', 80),
      c('M3', 'mini', '/Users/mike/src/brainhouse', 70),
    ];
    const { primary } = allocateSlots(cands, new Set(), 4);
    expect(primary).toEqual(new Set(['L1', 'L2', 'M1', 'M2']));
  });
});
