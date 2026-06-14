import { describe, expect, it } from 'vitest';
import { computeTopRatio, type FitState, nextFitRatio } from './fit.ts';

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

describe('nextFitRatio', () => {
  const DB = 0.001; // deadband in ratio units
  const fresh = (): FitState => ({ last: null, prev: null });

  it('applies the first measurement', () => {
    const r = nextFitRatio(fresh(), 0.2, DB);
    expect(r.apply).toBe(0.2);
    expect(r.state).toEqual({ last: 0.2, prev: null });
  });

  it('holds when the candidate is within the deadband of the last applied value', () => {
    const r = nextFitRatio({ last: 0.2, prev: 0.1 }, 0.2 + DB / 2, DB);
    expect(r.apply).toBeNull();
  });

  it('applies a genuine change', () => {
    const r = nextFitRatio({ last: 0.2, prev: null }, 0.25, DB);
    expect(r.apply).toBe(0.25);
    expect(r.state).toEqual({ last: 0.25, prev: 0.2 });
  });

  it('damps a two-value oscillation: holds the taller value and stops twitching', () => {
    // Simulate the wrap-induced ping-pong between 0.20 and 0.24.
    let s = fresh();
    const seq = [0.2, 0.24, 0.2, 0.24, 0.2, 0.24];
    const applied: (number | null)[] = [];
    for (const c of seq) {
      const r = nextFitRatio(s, c, DB);
      s = r.state;
      applied.push(r.apply);
    }
    // First two establish the pair; after that every bounce is refused and the
    // taller value (0.24) is held — no further applies.
    expect(applied[0]).toBe(0.2);
    expect(applied[1]).toBe(0.24);
    expect(applied.slice(2).every((a) => a === null)).toBe(true);
    expect(s.last).toBe(0.24);
  });

  it('still reacts to a genuinely new value after an oscillation settled', () => {
    let s: FitState = { last: 0.24, prev: 0.2 };
    // bounce back to 0.2 → refused
    expect(nextFitRatio(s, 0.2, DB).apply).toBeNull();
    // a new, larger measurement (e.g. a new process row) → applied
    const r = nextFitRatio(s, 0.31, DB);
    expect(r.apply).toBe(0.31);
  });
});
