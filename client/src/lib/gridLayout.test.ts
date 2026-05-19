import { describe, expect, it } from 'vitest';
import { computeCols } from './gridLayout.ts';

describe('computeCols', () => {
  it('1 slot → 1 column', () => {
    expect(computeCols(1600, 900, 1)).toBe(1);
  });

  it('wide viewport, 4 slots → 2 cols (2×2)', () => {
    expect(computeCols(1600, 900, 4)).toBe(2);
  });

  it('very wide viewport, 4 slots → more cols', () => {
    expect(computeCols(3200, 600, 4)).toBeGreaterThanOrEqual(3);
  });

  it('tall viewport, 4 slots → 1 col', () => {
    expect(computeCols(600, 2400, 4)).toBe(1);
  });

  it('6 slots, square viewport prefers ~3×2 or 2×3', () => {
    const c = computeCols(1200, 1200, 6);
    expect([2, 3]).toContain(c);
  });

  it('handles zero/negative dimensions gracefully', () => {
    expect(computeCols(0, 800, 4)).toBe(1);
    expect(computeCols(800, 0, 4)).toBe(1);
  });

  it('never returns more cols than slots', () => {
    for (let n = 1; n <= 12; n++) {
      expect(computeCols(2000, 800, n)).toBeLessThanOrEqual(n);
    }
  });
});
