import { describe, expect, it } from 'vitest';
import { parseQuery, parseWhen, requiredLiterals } from './query.js';

const NOW = 1_800_000_000;

describe('parseQuery', () => {
  it('splits bare words into required terms', () => {
    expect(parseQuery('foo  bar').terms).toEqual(['foo', 'bar']);
  });

  it('keeps a quoted phrase whole', () => {
    expect(parseQuery('"spawn EBADF" x').terms).toEqual(['spawn EBADF', 'x']);
  });

  it('takes an unclosed quote to the end', () => {
    expect(parseQuery('"half open').terms).toEqual(['half open']);
  });

  it('reads a regex with a default i flag', () => {
    const q = parseQuery('/fo+\\.ts/');
    expect(q.regex?.source).toBe('fo+\\.ts');
    expect(q.regex?.flags).toBe('i');
  });

  it('lets explicit flags replace the default', () => {
    expect(parseQuery('/Foo/s').regex?.flags).toBe('s');
  });

  it('keeps a slash inside a character class', () => {
    expect(parseQuery('/a[/]b/').regex?.source).toBe('a[/]b');
  });

  it('reports a bad regex instead of throwing', () => {
    const q = parseQuery('/(unclosed/ word');
    expect(q.regex).toBeNull();
    expect(q.errors[0]).toMatch(/bad regex/);
    expect(q.terms).toEqual(['word']);
  });

  it('treats a lone slash as a word', () => {
    expect(parseQuery('a / b').terms).toEqual(['a', '/', 'b']);
  });

  it('reads every filter', () => {
    const q = parseQuery(
      'project:brainhouse account:pw role:out tool:Bash after:7d before:2026-09-01 x',
      NOW,
    );
    expect(q.projects).toEqual(['brainhouse']);
    expect(q.accounts).toEqual(['PW']);
    expect(q.roles).toEqual(['out']);
    expect(q.tools).toEqual(['Bash']);
    expect(q.after).toBe(NOW - 7 * 86_400);
    expect(q.before).toBe(new Date('2026-09-01T00:00:00').getTime() / 1000);
    expect(q.terms).toEqual(['x']);
  });

  it('maps is:error to the error role', () => {
    expect(parseQuery('is:error').roles).toEqual(['error']);
  });

  it('takes a quoted filter value', () => {
    expect(parseQuery('project:"pw/cke"').projects).toEqual(['pw/cke']);
  });

  it('reports an unknown role and a bad date', () => {
    const q = parseQuery('role:robot after:someday');
    expect(q.errors).toHaveLength(2);
    expect(q.roles).toEqual([]);
  });

  it('treats an unknown key:value as a term', () => {
    expect(parseQuery('http://x y:z').terms).toEqual(['http://x', 'y:z']);
  });
});

describe('parseWhen', () => {
  it('reads hours and weeks', () => {
    expect(parseWhen('12h', NOW)).toBe(NOW - 12 * 3600);
    expect(parseWhen('2w', NOW)).toBe(NOW - 14 * 86_400);
  });
});

describe('requiredLiterals', () => {
  it.each([
    ['plain literal', 'EBADF', ['EBADF']],
    ['dot breaks a run', 'spawn.fail', ['spawn', 'fail']],
    ['escaped dot is literal', 'tracker\\.ts', ['tracker.ts']],
    ['optional char ends a run', 'colou?r', ['colo']],
    ['plus keeps the char', 'abc+def', ['abc', 'def']],
    ['star drops the char', 'abcd*ef', ['abc']],
    ['class breaks a run', 'foo[0-9]bar', ['foo', 'bar']],
    ['group is skipped', 'foo(bar)?baz', ['foo', 'baz']],
    ['top-level alternation gives up', 'foobar|bazqux', []],
    ['alternation inside a group is fine', 'prefix(a|b)suffix', ['prefix', 'suffix']],
    ['\\d is not literal', 'abc\\d+def', ['abc', 'def']],
    ['short runs dropped', 'ab.cd', []],
    ['counted quantifier', 'abcd{2}', ['abc']],
  ])('%s', (_name, src, want) => {
    expect(requiredLiterals(src)).toEqual(want);
  });
});
