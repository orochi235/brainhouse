import { describe, expect, it } from 'vitest';
import {
  iconForTool,
  parseBashCommandHead,
  shortenPath,
  stringifyToolValue,
  summarizeTool,
} from './tools.ts';

describe('parseBashCommandHead', () => {
  it('returns the first real token', () => {
    expect(parseBashCommandHead('ls -la')).toBe('ls');
    expect(parseBashCommandHead('git status')).toBe('git');
  });

  it('skips env assignments and wrappers', () => {
    expect(parseBashCommandHead('FOO=bar baz qux')).toBe('baz');
    expect(parseBashCommandHead('sudo apt-get install vim')).toBe('apt-get');
    expect(parseBashCommandHead('time npm test')).toBe('npm');
  });

  it('strips leading ./ or /', () => {
    expect(parseBashCommandHead('./script.sh')).toBe('script.sh');
    expect(parseBashCommandHead('/usr/bin/env node')).toBe('usr/bin/env');
  });

  it('returns empty for empty/whitespace', () => {
    expect(parseBashCommandHead('')).toBe('');
    expect(parseBashCommandHead('   ')).toBe('');
  });
});

describe('iconForTool', () => {
  it('maps known tools', () => {
    expect(iconForTool('Read', null)).toEqual({ kind: 'glyph', text: '📄' });
    expect(iconForTool('Grep', null)).toEqual({ kind: 'glyph', text: '🔎' });
  });

  it('Bash dispatches on CLI head', () => {
    const git = iconForTool('Bash', { command: 'git diff' });
    expect(git.kind).toBe('svg');
    const docker = iconForTool('Bash', { command: 'docker ps' });
    expect(docker.kind).toBe('svg');
  });

  it('Bash falls back to generic when CLI unknown', () => {
    expect(iconForTool('Bash', { command: 'frobnicate --x' })).toEqual({
      kind: 'glyph',
      text: '▶',
    });
  });

  it('unknown tool → default gear', () => {
    expect(iconForTool('NeverHeardOf', null)).toEqual({ kind: 'glyph', text: '⚙' });
  });
});

describe('shortenPath', () => {
  it('returns short paths as-is', () => {
    expect(shortenPath('a/b/c')).toBe('a/b/c');
    expect(shortenPath('foo')).toBe('foo');
  });

  it('truncates long paths to last two segments', () => {
    expect(shortenPath('/a/b/c/d/file.ts')).toBe('.../d/file.ts');
  });

  it('non-string → empty', () => {
    expect(shortenPath(undefined)).toBe('');
    expect(shortenPath(123)).toBe('');
  });
});

describe('summarizeTool', () => {
  it('Bash shows first line of command', () => {
    const out = summarizeTool({ name: 'Bash', input: { command: 'ls\nfoo' } }, null);
    expect(out).toBe('ls');
  });

  it('Bash truncates very long commands', () => {
    const long = 'a'.repeat(200);
    const out = summarizeTool({ name: 'Bash', input: { command: long } }, null);
    expect(out.length).toBeLessThanOrEqual(70);
    expect(out.endsWith('…')).toBe(true);
  });

  it('Read includes shortened path', () => {
    const out = summarizeTool({ name: 'Read', input: { file_path: '/a/b/c/d/e.ts' } }, null);
    expect(out).toBe('Read .../d/e.ts');
  });

  it('Grep quotes pattern', () => {
    const out = summarizeTool({ name: 'Grep', input: { pattern: 'foo', path: 'src/x.ts' } }, null);
    expect(out).toBe('Grep "foo" in src/x.ts');
  });

  it('result error → · error suffix', () => {
    const out = summarizeTool(
      { name: 'Bash', input: { command: 'ls' } },
      { tool_use_id: 't', content: 'no such file', is_error: true },
    );
    expect(out).toBe('ls  · error');
  });

  it('Read result reports line count', () => {
    const out = summarizeTool(
      { name: 'Read', input: { file_path: 'x.ts' } },
      { tool_use_id: 't', content: 'a\nb\nc', is_error: false },
    );
    expect(out).toMatch(/3 lines$/);
  });

  it('empty result → done', () => {
    const out = summarizeTool(
      { name: 'Bash', input: { command: 'ls' } },
      { tool_use_id: 't', content: '', is_error: false },
    );
    expect(out).toMatch(/· done$/);
  });

  it('unknown tool shows first input value', () => {
    const out = summarizeTool({ name: 'MysteryTool', input: { thing: 'value' } }, null);
    expect(out).toBe('MysteryTool: value');
  });
});

describe('stringifyToolValue', () => {
  it('pretty-prints objects', () => {
    expect(stringifyToolValue({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it('returns strings as-is', () => {
    expect(stringifyToolValue('hello')).toBe('hello');
  });

  it('null/undefined → empty', () => {
    expect(stringifyToolValue(null)).toBe('');
    expect(stringifyToolValue(undefined)).toBe('');
  });
});
