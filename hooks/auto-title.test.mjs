import { describe, expect, it } from 'vitest';
import {
  buildSlice,
  extractTurns,
  hasCustomTitleMeta,
  parseTitle,
  shouldFire,
} from './auto-title.mjs';

describe('shouldFire', () => {
  it('fires on placeholder once turn count >= 2', () => {
    expect(shouldFire(false, 0)).toBe(false);
    expect(shouldFire(false, 1)).toBe(false);
    expect(shouldFire(false, 2)).toBe(true);
    expect(shouldFire(false, 5)).toBe(true);
  });
  it('throttles periodic re-check to every 20th turn when a title is set', () => {
    expect(shouldFire(true, 1)).toBe(false);
    expect(shouldFire(true, 19)).toBe(false);
    expect(shouldFire(true, 20)).toBe(true);
    expect(shouldFire(true, 39)).toBe(false);
    expect(shouldFire(true, 40)).toBe(true);
  });
});

describe('parseTitle', () => {
  it('returns null on KEEP (any case)', () => {
    expect(parseTitle('KEEP')).toBeNull();
    expect(parseTitle('keep')).toBeNull();
    expect(parseTitle('Keep')).toBeNull();
  });
  it('strips wrapping quotes', () => {
    expect(parseTitle('"Wire auto-titling hook"')).toBe('Wire auto-titling hook');
    expect(parseTitle("'Wire auto-titling hook'")).toBe('Wire auto-titling hook');
  });
  it('rejects titles longer than 14 words', () => {
    const long = Array(15).fill('word').join(' ');
    expect(parseTitle(long)).toBeNull();
  });
  it('accepts exactly 14 words', () => {
    const fourteen = Array(14).fill('w').join(' ');
    expect(parseTitle(fourteen)).toBe(fourteen);
  });
  it('takes the last non-empty line when the CLI prefaces output', () => {
    expect(parseTitle('thinking...\nWire auto-titling hook')).toBe('Wire auto-titling hook');
  });
  it('returns null on empty / whitespace', () => {
    expect(parseTitle('')).toBeNull();
    expect(parseTitle('   \n  ')).toBeNull();
  });
});

describe('hasCustomTitleMeta', () => {
  it('returns true when a record_type:custom-title line exists', () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
      JSON.stringify({ record_type: 'custom-title', customTitle: 'My title' }),
    ];
    expect(hasCustomTitleMeta(lines)).toBe(true);
  });
  it('returns true when a top-level type:custom-title line exists', () => {
    const lines = [JSON.stringify({ type: 'custom-title', customTitle: 'My title' })];
    expect(hasCustomTitleMeta(lines)).toBe(true);
  });
  it('returns false on a transcript with no custom-title', () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'hello' } }),
    ];
    expect(hasCustomTitleMeta(lines)).toBe(false);
  });
  it('tolerates malformed JSON lines', () => {
    expect(hasCustomTitleMeta(['not json', 'also not json'])).toBe(false);
  });
});

describe('extractTurns', () => {
  it('separates user vs assistant text in order', () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'first' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'reply' } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'second' } }),
    ];
    const t = extractTurns(lines);
    expect(t.user).toEqual(['first', 'second']);
    expect(t.assistant).toEqual(['reply']);
  });
  it('drops the /clear artifact user_texts', () => {
    const lines = [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: '<local-command-caveat>x</local-command-caveat>' },
      }),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: '<command-name>/clear</command-name>' },
      }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'real prompt' } }),
    ];
    expect(extractTurns(lines).user).toEqual(['real prompt']);
  });
  it('skips sidechain (subagent) records', () => {
    const lines = [
      JSON.stringify({
        type: 'user',
        isSidechain: true,
        message: { role: 'user', content: 'sub' },
      }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'parent' } }),
    ];
    expect(extractTurns(lines).user).toEqual(['parent']);
  });
  it('extracts text from content arrays', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'part a' },
            { type: 'tool_use', id: 'x', name: 'X', input: {} },
            { type: 'text', text: 'part b' },
          ],
        },
      }),
    ];
    expect(extractTurns(lines).assistant).toEqual(['part a\npart b']);
  });
});

describe('buildSlice', () => {
  it('uses the first user prompt and pairs the last two turns', () => {
    const turns = {
      user: ['original ask', 'turn 2 user', 'turn 3 user', 'turn 4 user'],
      assistant: ['turn 1 asst', 'turn 2 asst', 'turn 3 asst', 'turn 4 asst'],
    };
    const slice = buildSlice(turns);
    expect(slice.first).toBe('original ask');
    expect(slice.recent).toContain('USER: turn 3 user');
    expect(slice.recent).toContain('ASSISTANT: turn 3 asst');
    expect(slice.recent).toContain('USER: turn 4 user');
    expect(slice.recent).toContain('ASSISTANT: turn 4 asst');
    expect(slice.recent).not.toContain('turn 2 user');
  });
  it('truncates very long fields', () => {
    const long = 'x'.repeat(2000);
    const slice = buildSlice({ user: [long], assistant: [long] });
    expect(slice.first.length).toBeLessThanOrEqual(500);
    expect(slice.first.endsWith('…')).toBe(true);
  });
});
