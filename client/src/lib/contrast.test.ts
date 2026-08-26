import { describe, expect, it } from 'vitest';
import { contrastRatio, readableInk } from './contrast.ts';

describe('contrastRatio', () => {
  it('is 21 for black on white', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
  });

  it('is 1 for a color against itself', () => {
    expect(contrastRatio('#3b82f6', '#3b82f6')).toBeCloseTo(1, 5);
  });

  it('is symmetric', () => {
    expect(contrastRatio('#ffffff', '#767676')).toBeCloseTo(contrastRatio('#767676', '#ffffff'), 5);
  });

  it('reads the space-separated hsl() form worktreeColor emits', () => {
    // hsl(0 0% 100%) is white.
    expect(contrastRatio('hsl(0 0% 100%)', '#000000')).toBeCloseTo(21, 5);
  });

  it('reads hex shorthand', () => {
    expect(contrastRatio('#fff', '#000')).toBeCloseTo(21, 5);
  });
});

describe('readableInk', () => {
  it('keeps white on a dark badge', () => {
    expect(readableInk('hsl(240 65% 35%)')).toBe('#fff');
  });

  it('inverts to black on a pale badge white cannot meet the ratio on', () => {
    // The pale-yellow case: white text on this is ~1.6:1.
    expect(readableInk('hsl(60 65% 75%)')).toBe('#000');
  });

  it('always clears 4.5:1 across the full hue circle at badge lightness', () => {
    for (let hue = 0; hue < 360; hue += 5) {
      for (const light of [32, 45, 55, 65, 75, 88]) {
        const bg = `hsl(${hue} 65% ${light}%)`;
        expect(contrastRatio(readableInk(bg), bg)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('never trades down when the minimum is unreachable', () => {
    // White clears 4.64:1 here and black only 4.52:1 — a stricter
    // minimum neither side meets must keep the better of the two.
    expect(readableInk('hsl(200 65% 40%)', 7)).toBe('#fff');
  });

  it('falls back to white when the color is unparseable', () => {
    expect(readableInk('var(--nope)')).toBe('#fff');
    expect(readableInk('linear-gradient(90deg, #000, #fff)')).toBe('#fff');
  });
});
