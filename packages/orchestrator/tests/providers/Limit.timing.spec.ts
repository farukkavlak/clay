import { describe, expect, it } from 'vitest';

import { growth, LINEAR, repeated } from '../../../../tests/growth';
import { Limit } from '../../src/providers/Limit';

/** How long `size` pieces of work take that all wait for one place. */
async function waited(size: number): Promise<number> {
  const limit = new Limit(1);
  const started = performance.now();
  await Promise.all(Array.from({ length: size }, () => limit.run(async () => {})));
  return performance.now() - started;
}

describe('a limit', () => {
  it('starts work that waits in time that grows with it', async () => {
    // Below 4000 an Array.shift queue is still cheap; far above it, waiting promises fill the heap.
    expect(await growth(4000, repeated(waited, 20))).toBeLessThan(LINEAR);
  });
});
