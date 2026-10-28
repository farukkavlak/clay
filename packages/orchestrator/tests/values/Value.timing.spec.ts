import { types } from '@clay/contracts';
import { describe, expect, it } from 'vitest';

import { growth, LINEAR } from '../../../../tests/growth';
import { child, valueOf, withSensitive } from '../../src/values/Value';

/** Milliseconds taking each of `size` sensitive values out of a map takes. */
function childEach(size: number): number {
  const keys = Array.from({ length: size }, (_, index) => `k${index}`);
  const map = withSensitive(
    valueOf(types.map(types.string), Object.fromEntries(keys.map((key) => [key, key]))),
    keys.map((key) => [key])
  );
  const started = performance.now();
  for (const key of keys) child(map, key);
  return performance.now() - started;
}

describe('a value with its type', () => {
  it('finds each sensitive value of a map in time that grows with the map', async () => {
    expect(await growth(8000, childEach)).toBeLessThan(LINEAR);
  });
});
