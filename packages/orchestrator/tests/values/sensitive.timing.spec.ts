import { EVERY_ITEM, EXACT, MAYBE } from '@clay/contracts';
import { describe, expect, it } from 'vitest';

import { growth, LINEAR } from '../../../../tests/growth';
import { fewest } from '../../src/values/sensitive';

/** Exact keys under as many keys, beside marks that may be so under every item and at each of those keys. */
function manyMarks(size: number) {
  const keys = Array.from({ length: size }, (_, index) => `k${index}`);
  return [
    [EVERY_ITEM, EVERY_ITEM, MAYBE],
    ...keys.map((key) => [EVERY_ITEM, key, MAYBE]),
    ...keys.map((key) => [`m${key}`, key, EXACT]),
    ...keys.map((key) => [`m${key}`, EVERY_ITEM, MAYBE]),
  ];
}

/** Milliseconds `fewest` takes over `manyMarks(size)`. */
function keptFewestIn(size: number): number {
  const started = performance.now();
  fewest(manyMarks(size));
  return performance.now() - started;
}

describe('the marks a value may have', () => {
  it('keep the fewest of a mark with a step every item, or a key spelled as one, at every depth in time that grows with its depth', () => {
    const deep = [...Array.from({ length: 24 }, () => EVERY_ITEM), MAYBE];
    const spelledAlike = [...Array.from({ length: 24 }, () => '-1'), MAYBE];
    const started = performance.now();

    expect(fewest([deep, ['x', MAYBE]])).toEqual([deep, ['x', MAYBE]]);
    expect(fewest([spelledAlike, [EVERY_ITEM, MAYBE]])).toEqual([[EVERY_ITEM, MAYBE]]);
    // Well under a millisecond where it grows with the depth, and seconds where each step every item doubles what is looked at.
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('an exact key or place', () => {
  it('and the marks beside it are kept fewest in time that grows with them', async () => {
    expect(await growth(4000, keptFewestIn)).toBeLessThan(LINEAR);
  });
});
