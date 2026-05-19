import { describe, expect, it } from 'vitest';
import { reorder, sortByOrder } from './panelOrder.ts';

describe('sortByOrder', () => {
  it('applies the saved order', () => {
    expect(sortByOrder(['a', 'b', 'c'], ['c', 'a', 'b'])).toEqual(['c', 'a', 'b']);
  });

  it('drops unknown ids from saved order', () => {
    expect(sortByOrder(['a', 'b'], ['gone', 'a', 'b'])).toEqual(['a', 'b']);
  });

  it('appends new ids in their original order', () => {
    expect(sortByOrder(['a', 'b', 'c', 'd'], ['c', 'a'])).toEqual(['c', 'a', 'b', 'd']);
  });

  it('returns input order when no preference', () => {
    expect(sortByOrder(['a', 'b'], [])).toEqual(['a', 'b']);
  });
});

describe('reorder', () => {
  it('moves source to target position', () => {
    expect(reorder([], ['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b']);
  });

  it('moves backward', () => {
    expect(reorder(['a', 'b', 'c', 'd'], ['a', 'b', 'c', 'd'], 'a', 'c')).toEqual([
      'b',
      'a',
      'c',
      'd',
    ]);
  });

  it('no-op when source === target', () => {
    const order = ['a', 'b', 'c'];
    expect(reorder(order, ['a', 'b', 'c'], 'b', 'b')).toBe(order);
  });

  it('no-op when target is unknown', () => {
    const order = ['a', 'b'];
    expect(reorder(order, ['a', 'b'], 'a', 'missing')).toBe(order);
  });

  it('works against an empty saved order using current known ids', () => {
    expect(reorder([], ['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'a', 'c']);
  });
});
