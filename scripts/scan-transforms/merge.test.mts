import { describe, expect, it } from 'vitest';
import { mergeObserved } from './merge.mts';
import type { ObservedDb, ScanResult } from './types.mts';

function result(perSelector: ScanResult['perSelector']): ScanResult {
  return {
    perSelector,
    clusters: [],
    maxVersionSeen: null,
    stats: { linesParsed: 0, malformedLines: 0, eventsTotal: 0, eventsUnmatchedSpecific: 0 },
  };
}

describe('mergeObserved', () => {
  const scanAt = '2026-06-20T00:00:00Z';

  it('creates entries for first-seen selectors', () => {
    const out = mergeObserved(
      {},
      result({ 'a.b': { count: 5, minVersion: '2.1.9', maxVersion: '2.1.112' } }),
      scanAt,
    );
    expect(out['a.b']).toEqual({
      firstSeenVersion: '2.1.9',
      lastSeenVersion: '2.1.112',
      lastWindowCount: 5,
      lastScanAt: scanAt,
    });
  });

  it('widens version bounds cumulatively and refreshes the window count', () => {
    const existing: ObservedDb = {
      'a.b': {
        firstSeenVersion: '2.0.0',
        lastSeenVersion: '2.1.50',
        lastWindowCount: 99,
        lastScanAt: 'old',
      },
    };
    const out = mergeObserved(
      existing,
      result({ 'a.b': { count: 3, minVersion: '2.1.10', maxVersion: '2.1.200' } }),
      scanAt,
    );
    expect(out['a.b']).toEqual({
      firstSeenVersion: '2.0.0',
      lastSeenVersion: '2.1.200',
      lastWindowCount: 3,
      lastScanAt: scanAt,
    });
  });

  it('keeps version bounds but zeroes the count when a selector is unseen this run', () => {
    const existing: ObservedDb = {
      'a.b': {
        firstSeenVersion: '2.0.0',
        lastSeenVersion: '2.1.50',
        lastWindowCount: 99,
        lastScanAt: 'old',
      },
    };
    const out = mergeObserved(
      existing,
      result({ 'a.b': { count: 0, minVersion: null, maxVersion: null } }),
      scanAt,
    );
    expect(out['a.b']).toEqual({
      firstSeenVersion: '2.0.0',
      lastSeenVersion: '2.1.50',
      lastWindowCount: 0,
      lastScanAt: scanAt,
    });
  });

  it('heals a stored "unknown" sentinel once a real version appears', () => {
    const existing: ObservedDb = {
      'a.b': {
        firstSeenVersion: 'unknown',
        lastSeenVersion: 'unknown',
        lastWindowCount: 0,
        lastScanAt: 'old',
      },
    };
    const out = mergeObserved(
      existing,
      result({ 'a.b': { count: 654, minVersion: '2.1.40', maxVersion: '2.1.118' } }),
      scanAt,
    );
    expect(out['a.b'].firstSeenVersion).toBe('2.1.40');
    expect(out['a.b'].lastSeenVersion).toBe('2.1.118');
  });
});
