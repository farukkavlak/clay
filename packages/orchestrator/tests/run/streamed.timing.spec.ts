import { describe, expect, it } from 'vitest';

import { growth, LINEAR } from '../../../../tests/growth';
import { streamed } from '../../src/run/streamed';

/** How long reading `size` events takes, all emitted before the reader comes. */
async function emitted(size: number): Promise<number> {
  const started = performance.now();
  for await (const _ of streamed<number, void>(async (emit) => {
    for (let index = 0; index < size; index++) emit(index);
  }));
  return performance.now() - started;
}

describe('streamed', () => {
  it('gives events emitted at once in time that grows with them', async () => {
    expect(await growth(8000, emitted)).toBeLessThan(LINEAR);
  });
});
