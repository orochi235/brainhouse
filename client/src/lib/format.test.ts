import { describe, expect, it } from 'vitest';
import {
  formatClockTime,
  formatDurationShort,
  formatDurationTwoUnits,
  formatElapsed,
  formatIdle,
  formatIdleCoarse,
} from './format.ts';

describe('formatDurationTwoUnits', () => {
  it('shows seconds-only under a minute', () => {
    expect(formatDurationTwoUnits(0)).toBe('0s');
    expect(formatDurationTwoUnits(45)).toBe('45s');
  });
  it('shows the two most significant nonzero units', () => {
    expect(formatDurationTwoUnits(90)).toBe('1m 30s');
    expect(formatDurationTwoUnits(3599)).toBe('59m 59s');
    expect(formatDurationTwoUnits(3660)).toBe('1h 1m');
    expect(formatDurationTwoUnits(86400 + 3 * 3600 + 180)).toBe('1d 3h');
  });
  it('drops a single trailing unit when the rest are zero', () => {
    expect(formatDurationTwoUnits(60)).toBe('1m');
    expect(formatDurationTwoUnits(3600)).toBe('1h');
    expect(formatDurationTwoUnits(86400)).toBe('1d');
    expect(formatDurationTwoUnits(604800)).toBe('1w');
  });
  it('skips zero intermediate units to reach the next nonzero one', () => {
    // 1w 0d 3h 3m → 1w 3h ; 1w 1d 3h 3m → 1w 1d
    expect(formatDurationTwoUnits(604800 + 3 * 3600 + 180)).toBe('1w 3h');
    expect(formatDurationTwoUnits(604800 + 86400 + 3 * 3600 + 180)).toBe('1w 1d');
    expect(formatDurationTwoUnits(604800 + 5)).toBe('1w 5s');
  });
});

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

  it('day+ leads with d; keeps zero subunits between two nonzero ones', () => {
    expect(formatIdle(86400)).toBe('1d');
    expect(formatIdle(86400 + 3600)).toBe('1d 1h');
    // Zero hours sandwiched between days and minutes is rendered, not skipped.
    expect(formatIdle(86400 + 3 * 60)).toBe('1d 0h 3m');
    expect(formatIdle(86400 + 13 * 3600 + 3 * 60)).toBe('1d 13h 3m');
    expect(formatIdle(86400 * 2 + 5)).toBe('2d');
  });
});

describe('formatDurationShort', () => {
  it('matches formatIdle for durations that already span ≤2 units', () => {
    expect(formatDurationShort(45)).toBe('45s');
    expect(formatDurationShort(60)).toBe('1m');
    expect(formatDurationShort(90)).toBe('1m 30s');
    expect(formatDurationShort(3600)).toBe('1h');
    expect(formatDurationShort(3660)).toBe('1h 1m');
  });

  it('caps at the two most significant units, dropping the rest', () => {
    // formatIdle would render these with three units.
    expect(formatDurationShort(86400 + 13 * 3600 + 3 * 60)).toBe('1d 13h');
    expect(formatDurationShort(86400 + 13 * 3600 + 3 * 60 + 5)).toBe('1d 13h');
  });

  it('drops a trailing zero second unit', () => {
    expect(formatDurationShort(86400)).toBe('1d');
    expect(formatDurationShort(86400 + 3 * 60)).toBe('1d'); // 0 hours → just days
    expect(formatDurationShort(86400 + 3600)).toBe('1d 1h');
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
