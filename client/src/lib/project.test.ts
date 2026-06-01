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

  it('keeps two segments for nested ~/src projects when there is no repo root', () => {
    expect(projectLabel('/Users/mike/src/pw/template')).toBe('pw/template');
    expect(projectLabel('/Users/jane/src/a/b/c')).toBe('b/c');
  });

  it('uses the repo leaf when a repo root is supplied', () => {
    // `pw/cke` and `pw/screener` are their own git repos — labels should
    // read as `cke` and `screener`, not `pw/cke` and `pw/screener`.
    expect(projectLabel('/Users/mike/src/pw/cke', '/Users/mike/src/pw/cke')).toBe('cke');
    expect(projectLabel('/Users/mike/src/pw/screener', '/Users/mike/src/pw/screener')).toBe(
      'screener',
    );
    // Subdir of the repo collapses to the repo's leaf — the cwd tooltip
    // still has the full path for disambiguation.
    expect(
      projectLabel('/Users/mike/src/pw/cke/packages/api', '/Users/mike/src/pw/cke'),
    ).toBe('cke');
  });

  it('ignores empty / nullish repo root', () => {
    expect(projectLabel('/Users/mike/src/brainhouse', null)).toBe('brainhouse');
    expect(projectLabel('/Users/mike/src/brainhouse', '')).toBe('brainhouse');
    expect(projectLabel('/Users/mike/src/brainhouse', undefined)).toBe('brainhouse');
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
