import { describe, expect, it } from 'vitest';
import { compareVersions, maxVersion, minVersion } from './version.mts';

describe('compareVersions', () => {
  it('orders by numeric segment, not lexically', () => {
    expect(compareVersions('2.1.112', '2.1.9')).toBeGreaterThan(0);
    expect(compareVersions('2.1.9', '2.1.112')).toBeLessThan(0);
    expect(compareVersions('2.1.0', '2.1.0')).toBe(0);
  });
  it('treats missing segments as zero', () => {
    expect(compareVersions('2.1', '2.1.0')).toBe(0);
    expect(compareVersions('2.2', '2.1.999')).toBeGreaterThan(0);
  });
});

describe('min/maxVersion', () => {
  it('is null-safe', () => {
    expect(maxVersion(null, '2.1.0')).toBe('2.1.0');
    expect(maxVersion('2.1.0', null)).toBe('2.1.0');
    expect(maxVersion(null, null)).toBeNull();
    expect(minVersion(null, '2.1.0')).toBe('2.1.0');
  });
  it('picks the numerically larger/smaller', () => {
    expect(maxVersion('2.1.9', '2.1.112')).toBe('2.1.112');
    expect(minVersion('2.1.9', '2.1.112')).toBe('2.1.9');
  });
});
