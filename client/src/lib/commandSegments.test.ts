import { describe, expect, it } from 'vitest';
import { splitCommandSegments } from './commandSegments.ts';

describe('splitCommandSegments', () => {
  it('returns a single segment when there is no ;', () => {
    expect(splitCommandSegments('npm run build')).toEqual(['npm run build']);
  });

  it('splits at top-level ; keeping the separator, absorbing whitespace', () => {
    expect(splitCommandSegments('cd /tmp;   ls -la; echo done')).toEqual([
      'cd /tmp;',
      'ls -la;',
      'echo done',
    ]);
  });

  it('ignores ; inside single quotes', () => {
    expect(splitCommandSegments("echo 'a; b'; ls")).toEqual(["echo 'a; b';", 'ls']);
  });

  it('ignores ; inside double quotes', () => {
    expect(splitCommandSegments('echo "a; b"; ls')).toEqual(['echo "a; b";', 'ls']);
  });

  it('ignores ; inside backticks', () => {
    expect(splitCommandSegments('echo `foo; bar`; ls')).toEqual(['echo `foo; bar`;', 'ls']);
  });

  it('ignores ; inside $( ) and subshells', () => {
    expect(splitCommandSegments('echo $(foo; bar); ls')).toEqual(['echo $(foo; bar);', 'ls']);
    expect(splitCommandSegments('(cd /tmp; ls); pwd')).toEqual(['(cd /tmp; ls);', 'pwd']);
  });

  it('respects backslash escapes', () => {
    expect(splitCommandSegments('echo a\\; b; ls')).toEqual(['echo a\\; b;', 'ls']);
  });

  it('does not treat backslash in single quotes as an escape', () => {
    expect(splitCommandSegments("echo 'a\\'; ls")).toEqual(["echo 'a\\';", 'ls']);
  });

  it('keeps ;; together (case arms)', () => {
    expect(splitCommandSegments('a) foo;; b) bar')).toEqual(['a) foo;;', 'b) bar']);
  });

  it('drops a trailing whitespace-only remainder', () => {
    expect(splitCommandSegments('ls; ')).toEqual(['ls;']);
  });

  it('never splits inside an unterminated quote', () => {
    expect(splitCommandSegments('echo "a; b')).toEqual(['echo "a; b']);
  });
});
