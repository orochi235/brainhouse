import { describe, expect, it } from 'vitest';
import { projectLabel } from './project.ts';

describe('projectLabel', () => {
  it('returns empty for missing cwd', () => {
    expect(projectLabel(null)).toBe('');
    expect(projectLabel(undefined)).toBe('');
    expect(projectLabel('')).toBe('');
  });

  it('basename of ~/src project', () => {
    expect(projectLabel('/Users/mike/src/brainhouse')).toBe('brainhouse');
  });

  it('keeps two segments for nested ~/src projects', () => {
    expect(projectLabel('/Users/mike/src/pw/template')).toBe('pw/template');
    expect(projectLabel('/Users/jane/src/a/b/c')).toBe('b/c');
  });

  it('home folder collapses to ~', () => {
    expect(projectLabel('/Users/mike')).toBe('~');
  });

  it('~/src bare', () => {
    expect(projectLabel('/Users/mike/src')).toBe('~/src');
  });

  it('non-home paths keep last two segments with leading slash', () => {
    expect(projectLabel('/tmp/foo/bar')).toBe('/foo/bar');
    expect(projectLabel('/var/log')).toBe('/var/log');
  });

  it('trailing slash is ignored', () => {
    expect(projectLabel('/Users/mike/src/brainhouse/')).toBe('brainhouse');
  });
});
