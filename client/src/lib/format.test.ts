import { describe, expect, it } from 'vitest';
import { formatClockTime, formatElapsed, formatIdle, formatIdleCoarse } from './format.ts';

describe('formatIdle', () => {
  it('sub-minute → seconds', () => {
    expect(formatIdle(0)).toBe('0s');
    expect(formatIdle(45)).toBe('45s');
    expect(formatIdle(59.9)).toBe('59s');
  });

  it('sub-hour → m or m s', () => {
    expect(formatIdle(60)).toBe('1m');
    expect(formatIdle(90)).toBe('1m 30s');
    expect(formatIdle(3599)).toBe('59m 59s');
  });

  it('hour+ → h or h m', () => {
    expect(formatIdle(3600)).toBe('1h');
    expect(formatIdle(3660)).toBe('1h 1m');
    expect(formatIdle(7200)).toBe('2h');
  });
});

describe('formatIdleCoarse', () => {
  it('returns largest unit only', () => {
    expect(formatIdleCoarse(30)).toBe('30s');
    expect(formatIdleCoarse(125)).toBe('2m');
    expect(formatIdleCoarse(3700)).toBe('1h');
    expect(formatIdleCoarse(86400 * 2 + 5)).toBe('2d');
  });
});

describe('formatElapsed', () => {
  it('prefixes with + and skips zero subunits', () => {
    expect(formatElapsed(5)).toBe('+5s');
    expect(formatElapsed(60)).toBe('+1m');
    expect(formatElapsed(75)).toBe('+1m15s');
    expect(formatElapsed(3600)).toBe('+1h');
    expect(formatElapsed(3725)).toBe('+1h2m');
  });
});

describe('formatClockTime', () => {
  it('parses a valid ISO timestamp', () => {
    const out = formatClockTime('2026-05-19T08:30:15Z');
    expect(out).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it('falls back to current time on invalid input', () => {
    expect(formatClockTime('not-a-date')).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(formatClockTime('')).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
});
