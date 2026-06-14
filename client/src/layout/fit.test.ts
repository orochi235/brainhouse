import { describe, expect, it } from 'vitest';
import { computeTopRatio } from './fit.ts';

describe('computeTopRatio', () => {
  it('returns the content fraction when content is between the floor and the cap', () => {
    // 263px of content in a 1365px viewport → ~0.1927.
    expect(computeTopRatio(263, 1365, { minPx: 48, maxFraction: 0.4 })).toBeCloseTo(263 / 1365, 5);
  });

  it('caps the ratio so a tall list cannot starve the workspace', () => {
    // 900px of content would be 0.66 of the viewport; cap holds it at 0.4.
    expect(computeTopRatio(900, 1365, { minPx: 48, maxFraction: 0.4 })).toBe(0.4);
  });

  it('floors the ratio at minPx so a mid-load measurement cannot pin the gutter at zero', () => {
    expect(computeTopRatio(10, 1365, { minPx: 48, maxFraction: 0.4 })).toBeCloseTo(48 / 1365, 5);
  });

  it('returns null when nothing is measurable yet (children not laid out)', () => {
    expect(computeTopRatio(0, 1365, { minPx: 48, maxFraction: 0.4 })).toBeNull();
  });

  it('returns null for a non-positive viewport', () => {
    expect(computeTopRatio(263, 0, { minPx: 48, maxFraction: 0.4 })).toBeNull();
  });
});
