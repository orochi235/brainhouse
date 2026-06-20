import { describe, expect, it } from 'vitest';
import { isPlaceholderTitle } from './sessionTitle.ts';

describe('isPlaceholderTitle', () => {
  const id = 'de83b1b9-4184-4e24-a8a9-d3ca1dfe4337';

  it('treats an empty/whitespace title as a placeholder', () => {
    expect(isPlaceholderTitle('', id)).toBe(true);
    expect(isPlaceholderTitle('   ', id)).toBe(true);
  });

  it('treats the server short-id placeholder (id.slice(0,8)) as a placeholder', () => {
    expect(isPlaceholderTitle('de83b1b9', id)).toBe(true);
  });

  it('treats a bare hex/uuid fragment as a placeholder', () => {
    expect(isPlaceholderTitle('00f81d0c', 'zzzzzzzz')).toBe(true);
    expect(isPlaceholderTitle('de83b1b9-4184-4e24', 'zzzzzzzz')).toBe(true);
  });

  it('does NOT treat a real prose title as a placeholder', () => {
    expect(isPlaceholderTitle('Fix the parser bug', id)).toBe(false);
    expect(isPlaceholderTitle('show me some todo options', id)).toBe(false);
  });

  it('does NOT misread all-letter hex-ish words (no digit) as placeholders', () => {
    expect(isPlaceholderTitle('decade', id)).toBe(false);
    expect(isPlaceholderTitle('facade', id)).toBe(false);
    expect(isPlaceholderTitle('cafe', id)).toBe(false);
  });

  it('does NOT treat version-ish or punctuated strings as placeholders', () => {
    expect(isPlaceholderTitle('v2.1.177', id)).toBe(false);
  });
});
