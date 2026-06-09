import { describe, expect, it } from 'vitest';
import { VIEW_TRANSFORMS } from '../../transforms/registry.ts';
import { TRANSFORM_SOURCE } from './sources.ts';

describe('TRANSFORM_SOURCE manifest', () => {
  it('has one entry per registered transform, same keys', () => {
    const manifest = Object.keys(TRANSFORM_SOURCE).sort();
    const registry = VIEW_TRANSFORMS.map((t) => t.key).sort();
    expect(manifest).toEqual(registry);
  });

  it('every entry is a non-empty string', () => {
    for (const [key, src] of Object.entries(TRANSFORM_SOURCE)) {
      expect(typeof src, key).toBe('string');
      expect(src.length, key).toBeGreaterThan(0);
    }
  });
});
