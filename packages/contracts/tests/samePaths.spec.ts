import { describe, expect, it } from 'vitest';

import { samePaths } from '../src';

describe('samePaths', () => {
  it('takes the same paths in another order as the same', () => {
    expect(samePaths([['a'], ['b', 0]], [['b', 0], ['a']])).toBe(true);
  });

  it.each([
    ['a path the other lacks', [['a'], ['b']], [['a']]],
    ['another path', [['a']], [['b']]],
    ['an index where the other has a key', [['l', 0]], [['l', '0']]],
    ['one path twice where the other has two', [['a'], ['a']], [['a'], ['b']]],
  ])('tells apart lists where one has %s', (_, one, other) => {
    expect(samePaths(one, other)).toBe(false);
    expect(samePaths(other, one)).toBe(false);
  });
});
