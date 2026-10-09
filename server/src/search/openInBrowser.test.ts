import { describe, expect, it } from 'vitest';
import { openSearchInBrowser, searchUrl } from './openInBrowser.js';

describe('searchUrl', () => {
  it('encodes characters that would break the query parameter', () => {
    const url = searchUrl('http://localhost:8765', 'a&b c#%/"x"');
    expect(new URL(url).searchParams.get('q')).toBe('a&b c#%/"x"');
  });
});

describe('openSearchInBrowser', () => {
  it('opens Chrome by bundle id', async () => {
    const calls: string[][] = [];
    await openSearchInBrowser('http://h', 'q', async (cmd, args) => {
      calls.push([cmd, ...args]);
    });
    expect(calls).toEqual([['open', '-b', 'com.google.Chrome', 'http://h/?q=q']]);
  });

  it('falls back to the default browser without Chrome', async () => {
    const calls: string[][] = [];
    await openSearchInBrowser('http://h', 'q', async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args[0] === '-b') throw new Error('no Chrome');
    });
    expect(calls.at(-1)).toEqual(['open', 'http://h/?q=q']);
  });
});
