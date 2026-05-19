import { describe, expect, test } from 'vitest';
import { renderInlineCode } from './inlineCode';

describe('renderInlineCode', () => {
  test('plain text passes through', () => {
    expect(renderInlineCode('hello world')).toEqual(['hello world']);
  });

  test('paired backticks become a <code> element', () => {
    const result = renderInlineCode('fix `useEffect` cleanup');
    expect(result).toHaveLength(3);
    expect(result[0]).toBe('fix ');
    expect(result[2]).toBe(' cleanup');
    // Middle element is a React element with the right text.
    const code = result[1] as { props: { children: string } };
    expect(code.props.children).toBe('useEffect');
  });

  test('multiple code spans', () => {
    const result = renderInlineCode('use `foo` and `bar` together');
    expect(result.filter((n) => typeof n !== 'string')).toHaveLength(2);
  });

  test('unpaired trailing backtick is preserved as text', () => {
    expect(renderInlineCode('weird `case')).toEqual(['weird ', '`case']);
  });

  test('empty string yields empty array', () => {
    expect(renderInlineCode('')).toEqual([]);
  });
});
