import { describe, expect, it } from 'vitest';
import {
  buildEditorUrl,
  EDITOR_PRESETS,
  editorPresetIdForTemplate,
  findFilenameMatches,
  resolveAbsolute,
  segmentFilenameLinks,
} from './filenameLinks.ts';

describe('findFilenameMatches', () => {
  it('finds absolute paths with extension', () => {
    const m = findFilenameMatches('see /Users/me/src/foo.ts for details');
    expect(m).toHaveLength(1);
    expect(m[0].path).toBe('/Users/me/src/foo.ts');
    expect(m[0].line).toBeUndefined();
  });

  it('captures :line and :col suffixes', () => {
    const m = findFilenameMatches('error at /a/b.ts:42:7 line');
    expect(m[0].path).toBe('/a/b.ts');
    expect(m[0].line).toBe(42);
    expect(m[0].col).toBe(7);
  });

  it('matches relative paths with extensions', () => {
    const m = findFilenameMatches('open src/components/Foo.tsx now');
    expect(m).toHaveLength(1);
    expect(m[0].path).toBe('src/components/Foo.tsx');
  });

  it('matches extensionless relative paths only when :line is present', () => {
    const m1 = findFilenameMatches('see to/the future');
    expect(m1).toHaveLength(0);
    const m2 = findFilenameMatches('see src/utils:5 there');
    expect(m2).toHaveLength(1);
    expect(m2[0].line).toBe(5);
  });

  it('does not match URL paths', () => {
    const m = findFilenameMatches('visit https://example.com/foo/bar.html for info');
    expect(m).toHaveLength(0);
  });

  it('strips trailing sentence punctuation', () => {
    const m = findFilenameMatches('look at src/foo.ts.');
    expect(m).toHaveLength(1);
    expect(m[0].raw).toBe('src/foo.ts');
  });

  it('handles ~/ paths', () => {
    const m = findFilenameMatches('open ~/.bashrc:1 yo');
    expect(m).toHaveLength(1);
    expect(m[0].path).toBe('~/.bashrc');
    expect(m[0].line).toBe(1);
  });

  it('returns multiple matches in order', () => {
    const m = findFilenameMatches('a/b.ts and c/d.ts');
    expect(m).toHaveLength(2);
    expect(m.map((x) => x.path)).toEqual(['a/b.ts', 'c/d.ts']);
  });

  it('rejects bare folders without extension or line', () => {
    const m = findFilenameMatches('cd src/components and try again');
    expect(m).toHaveLength(0);
  });
});

describe('segmentFilenameLinks', () => {
  it('returns a single text segment when no matches', () => {
    expect(segmentFilenameLinks('plain prose with no paths')).toEqual([
      { kind: 'text', value: 'plain prose with no paths' },
    ]);
  });

  it('splits text around matches', () => {
    const segs = segmentFilenameLinks('see /a/b.ts now');
    expect(segs).toHaveLength(3);
    expect(segs[0]).toEqual({ kind: 'text', value: 'see ' });
    expect(segs[1].kind).toBe('link');
    expect(segs[2]).toEqual({ kind: 'text', value: ' now' });
  });
});

describe('resolveAbsolute', () => {
  it('passes absolute paths through', () => {
    expect(resolveAbsolute('/a/b', '/cwd')).toBe('/a/b');
  });

  it('joins relative paths onto cwd', () => {
    expect(resolveAbsolute('src/foo.ts', '/Users/me/proj')).toBe('/Users/me/proj/src/foo.ts');
  });

  it('strips ./ from relative paths', () => {
    expect(resolveAbsolute('./src/foo.ts', '/proj')).toBe('/proj/src/foo.ts');
  });

  it('expands ~ when home provided', () => {
    expect(resolveAbsolute('~/bin/x', null, '/Users/me')).toBe('/Users/me/bin/x');
  });

  it('leaves ~ alone when no home', () => {
    expect(resolveAbsolute('~/bin/x', null)).toBe('~/bin/x');
  });
});

describe('buildEditorUrl', () => {
  it('substitutes placeholders', () => {
    expect(buildEditorUrl('cursor://file/{path}:{line}', '/a/b.ts', 42)).toBe(
      'cursor://file//a/b.ts:42',
    );
  });

  it('encodes path', () => {
    expect(buildEditorUrl('x://{path}', '/has space/foo.ts')).toBe('x:///has%20space/foo.ts');
  });

  it('defaults missing line/col to 1', () => {
    expect(buildEditorUrl('x://{path}:{line}:{col}', '/a.ts')).toBe('x:///a.ts:1:1');
  });

  it('returns null for empty template', () => {
    expect(buildEditorUrl('', '/a.ts')).toBeNull();
  });
});

describe('editorPresetIdForTemplate', () => {
  it('matches a known preset', () => {
    expect(editorPresetIdForTemplate(EDITOR_PRESETS[0].template)).toBe(EDITOR_PRESETS[0].id);
  });

  it('returns custom for unknown templates', () => {
    expect(editorPresetIdForTemplate('myeditor://{path}')).toBe('custom');
  });
});
