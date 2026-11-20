import { describe, expect, it } from 'vitest';

import { EVERY_ITEM, EXACT, holdsFirst, MAYBE, SOMEWHERE } from '../src';

describe('holdsFirst', () => {
  it.each([
    ['a mark for certain at the step', ['a']],
    ['a mark for certain below the step', ['a', 'c']],
    ['the step held exactly', ['a', EXACT]],
    ['a place held exactly', [0, EXACT]],
  ])('says the step is there for %s', (_, path) => {
    expect(holdsFirst(path)).toBe(true);
  });

  it.each([
    ['a mark that it may be sensitive', ['a', MAYBE]],
    ['a key held exactly below the step', ['a', 'c', EXACT]],
    ['a mark under every item', [EVERY_ITEM, 'c']],
    ['a value sensitive somewhere', [SOMEWHERE]],
    ['the whole value', []],
  ])('does not for %s', (_, path) => {
    expect(holdsFirst(path)).toBe(false);
  });
});
