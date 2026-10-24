import { describe, expect, it } from 'vitest';

import { EVERY_ITEM, EXACT, MAYBE, sensitiveUnder } from '../src';

describe('sensitiveUnder', () => {
  it('keeps what is left of the paths that start with the step', () => {
    expect(sensitiveUnder([['a', 'b'], ['c']], 'a')).toEqual([['b']]);
  });

  it('gives every part of a value marked as a whole', () => {
    expect(sensitiveUnder([[]], 'a')).toEqual([[]]);
  });

  it.each([0, 7, 'key'])('marks the item at %s whole where every item is marked', (step) => {
    expect(sensitiveUnder([[EVERY_ITEM]], step)).toEqual([[]]);
  });

  it('keeps what is left of the path under every item', () => {
    expect(sensitiveUnder([[EVERY_ITEM, 'password']], 2)).toEqual([['password']]);
  });

  it('leaves a path that names another item next to the one for every item', () => {
    expect(
      sensitiveUnder(
        [
          [1, 'a'],
          [EVERY_ITEM, 'b'],
        ],
        1
      )
    ).toEqual([['a'], ['b']]);
  });

  it.each([
    [
      'keeps out of an exact key a mark that may be so under every item',
      [
        [EVERY_ITEM, MAYBE],
        ['c', EXACT],
      ],
      'c',
      [],
    ],
    [
      'leaves that mark at another key',
      [
        [EVERY_ITEM, MAYBE],
        ['c', EXACT],
      ],
      'a',
      [[MAYBE]],
    ],
    [
      'gives an exact key a mark under every item for certain',
      [
        [EVERY_ITEM, 'x'],
        ['c', EXACT],
      ],
      'c',
      [['x']],
    ],
    ['gives an exact key the whole that may be sensitive', [[MAYBE], ['c', EXACT]], 'c', [[MAYBE]]],
    [
      'leaves nothing of the exact path itself',
      [
        ['c', EXACT],
        ['c', 'p'],
      ],
      'c',
      [['p']],
    ],
    ['keeps an exact path inside every item', [[EVERY_ITEM, 'c', EXACT]], 0, [['c', EXACT]]],
  ])('%s', (_, paths, step, below) => {
    expect(sensitiveUnder(paths, step)).toEqual(below);
  });
});
