import type { Event } from '@server/parser.ts';
import { describe, expect, it } from 'vitest';
import { resolveSelector, SELECTOR_REGISTRY } from './registry.ts';

describe('SELECTOR_REGISTRY', () => {
  it('has unique keys', () => {
    const keys = SELECTOR_REGISTRY.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it.each(SELECTOR_REGISTRY)('selector %s parses, compiles, and matches its samplePayload', (def) => {
    const sel = resolveSelector(def.key);
    expect(sel.source).toBe(def.selector);
    expect(typeof sel.match).toBe('function');
    expect(def.samplePayload).toBeDefined();
    expect(sel.match(def.samplePayload as Event)).toBe(true);
  });

  it('memoizes — same instance returned across calls', () => {
    const a = resolveSelector('tool-use.any');
    const b = resolveSelector('tool-use.any');
    expect(a).toBe(b);
  });

  it('throws on unknown key', () => {
    expect(() => resolveSelector('nope.never')).toThrow(/unknown selector/i);
  });
});
