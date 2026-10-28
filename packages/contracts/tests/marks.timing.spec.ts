import { describe, expect, it } from 'vitest';

import { growth, LINEAR } from '../../../tests/growth';
import { Marks } from '../src/marks';

/** Milliseconds going under each of `size` keys takes. */
function underEach(size: number): number {
  const marks = Marks.of(Array.from({ length: size }, (_, index) => [`k${index}`]));
  const started = performance.now();
  for (let index = 0; index < size; index++) marks.under(`k${index}`).paths();
  return performance.now() - started;
}

describe('marks held by their steps', () => {
  it('go under each step of many marks in time that grows with them', async () => {
    expect(await growth(10_000, underEach)).toBeLessThan(LINEAR);
  });
});
