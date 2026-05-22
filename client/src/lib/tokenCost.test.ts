import { describe, expect, it } from 'vitest';
import {
  cacheHealth,
  cacheHitRate,
  estimateCostUsd,
  formatUsd,
  inputEquivalentTokens,
} from './tokenCost.ts';

describe('inputEquivalentTokens', () => {
  it('weights each bucket by its billing coefficient', () => {
    // 1k input + 1k cache_create + 1k cache_read + 1k output
    // = 1·1000 + 1.25·1000 + 0.1·1000 + 5·1000 = 7350
    expect(
      inputEquivalentTokens({
        input: 1000,
        cache_create: 1000,
        cache_read: 1000,
        output: 1000,
      }),
    ).toBe(7350);
  });

  it('collapses a cache-heavy session to a much smaller headline', () => {
    // 100k cache_read totals 100k raw but only 10k input-equivalent.
    const raw = { input: 0, cache_create: 0, cache_read: 100_000, output: 0 };
    expect(inputEquivalentTokens(raw)).toBe(10_000);
  });

  it('returns 0 for an empty bucket set', () => {
    expect(
      inputEquivalentTokens({ input: 0, cache_create: 0, cache_read: 0, output: 0 }),
    ).toBe(0);
  });
});

describe('estimateCostUsd', () => {
  it('prices opus-4 at the public rate', () => {
    // 1M input alone = $15.
    const usd = estimateCostUsd({
      model: 'claude-opus-4-7',
      input: 1_000_000,
      output: 0,
      cache_create: 0,
      cache_read: 0,
    });
    expect(usd).toBeCloseTo(15, 5);
  });

  it('returns null when the model is unknown', () => {
    expect(
      estimateCostUsd({
        model: 'some-other-model',
        input: 1000,
        output: 0,
        cache_create: 0,
        cache_read: 0,
      }),
    ).toBeNull();
  });

  it('returns null when model is null', () => {
    expect(
      estimateCostUsd({ model: null, input: 1, output: 0, cache_create: 0, cache_read: 0 }),
    ).toBeNull();
  });
});

describe('cacheHitRate', () => {
  it('returns null when nothing cacheable yet', () => {
    expect(
      cacheHitRate({ input: 0, output: 1000, cache_create: 0, cache_read: 0 }),
    ).toBeNull();
  });

  it('excludes output from the denominator', () => {
    // 80% cache read + 20% uncached input. Big output shouldn't drag this down.
    expect(
      cacheHitRate({ input: 200, output: 100_000, cache_create: 0, cache_read: 800 }),
    ).toBeCloseTo(0.8, 5);
  });
});

describe('cacheHealth', () => {
  it('reports unknown until enough cacheable traffic accumulates', () => {
    // Below 50k cacheable, ratios are too noisy.
    expect(
      cacheHealth({ input: 100, output: 0, cache_create: 0, cache_read: 0 }),
    ).toBe('unknown');
  });

  it('flags poor when cache hit rate is below 40% at scale', () => {
    expect(
      cacheHealth({ input: 80_000, output: 0, cache_create: 0, cache_read: 20_000 }),
    ).toBe('poor');
  });

  it('reports healthy at typical steady-state ratios', () => {
    expect(
      cacheHealth({ input: 5000, output: 5000, cache_create: 5000, cache_read: 90_000 }),
    ).toBe('healthy');
  });

  it('reports mixed in between', () => {
    expect(
      cacheHealth({ input: 30_000, output: 0, cache_create: 10_000, cache_read: 60_000 }),
    ).toBe('mixed');
  });
});

describe('formatUsd', () => {
  it('floors tiny amounts', () => {
    expect(formatUsd(0.003)).toBe('<$0.01');
  });
  it('uses two decimals under $10', () => {
    expect(formatUsd(2.456)).toBe('$2.46');
  });
  it('uses one decimal in the tens', () => {
    expect(formatUsd(42.5)).toBe('$42.5');
  });
  it('rounds large amounts to whole dollars', () => {
    expect(formatUsd(1234.56)).toBe('$1,235');
  });
});
