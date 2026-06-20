import { describe, expect, it } from 'vitest';
import observed from './observed.json';
import { SELECTOR_REGISTRY } from './registry.ts';

describe('observed.json drift guard', () => {
  const registryKeys = new Set(SELECTOR_REGISTRY.map((d) => d.key));
  const observedKeys = new Set(Object.keys(observed as Record<string, unknown>));

  it('has an entry for every registry selector', () => {
    const missing = [...registryKeys].filter((k) => !observedKeys.has(k));
    expect(missing).toEqual([]);
  });

  it('has no entries for selectors absent from the registry', () => {
    const extra = [...observedKeys].filter((k) => !registryKeys.has(k));
    expect(extra).toEqual([]);
  });

  it('every entry has the expected shape', () => {
    for (const entry of Object.values(observed as Record<string, Record<string, unknown>>)) {
      expect(typeof entry.firstSeenVersion).toBe('string');
      expect(typeof entry.lastSeenVersion).toBe('string');
      expect(typeof entry.lastWindowCount).toBe('number');
      expect(typeof entry.lastScanAt).toBe('string');
    }
  });
});
