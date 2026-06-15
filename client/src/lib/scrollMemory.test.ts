import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearScrollPosition,
  loadScrollPosition,
  pruneScrollPositions,
  saveScrollPosition,
} from './scrollMemory.ts';

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('scrollMemory', () => {
  it('returns null when nothing is stored', () => {
    expect(loadScrollPosition('a')).toBeNull();
  });

  it('round-trips a position', () => {
    saveScrollPosition('a', 420);
    expect(loadScrollPosition('a')).toBe(420);
  });

  it('expires after 60s', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    saveScrollPosition('a', 100);
    vi.setSystemTime(30_000);
    expect(loadScrollPosition('a')).toBe(100);
    vi.setSystemTime(65_000);
    expect(loadScrollPosition('a')).toBeNull();
  });

  it('clear removes the entry', () => {
    saveScrollPosition('a', 100);
    clearScrollPosition('a');
    expect(loadScrollPosition('a')).toBeNull();
  });

  it('returns null for malformed entries (corrupted storage)', () => {
    sessionStorage.setItem('bh:scroll:a', '{not valid json');
    expect(loadScrollPosition('a')).toBeNull();
  });

  it('different panel ids are independent', () => {
    saveScrollPosition('a', 100);
    saveScrollPosition('b', 200);
    expect(loadScrollPosition('a')).toBe(100);
    expect(loadScrollPosition('b')).toBe(200);
  });

  it('prune drops entries for panels not in the live set', () => {
    saveScrollPosition('a', 100);
    saveScrollPosition('b', 200);
    saveScrollPosition('c', 300);
    pruneScrollPositions(new Set(['b']));
    expect(loadScrollPosition('a')).toBeNull();
    expect(loadScrollPosition('b')).toBe(200);
    expect(loadScrollPosition('c')).toBeNull();
  });

  it('prune leaves unrelated sessionStorage keys untouched', () => {
    sessionStorage.setItem('unrelated', 'keep me');
    saveScrollPosition('a', 100);
    pruneScrollPositions(new Set());
    expect(loadScrollPosition('a')).toBeNull();
    expect(sessionStorage.getItem('unrelated')).toBe('keep me');
  });
});
