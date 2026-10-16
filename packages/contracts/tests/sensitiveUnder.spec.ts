import { describe, expect, it } from 'vitest';

import { EVERY_ITEM, sensitiveUnder } from '../src';

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
});
