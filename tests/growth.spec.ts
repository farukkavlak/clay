import { describe, expect, it } from 'vitest';

import { growth } from './growth';

describe('growth', () => {
  it('is about four for work that grows with its size, and sixteen for work that holds each part against every other', async () => {
    expect(await growth(10, (size) => size)).toBe(4);
    expect(await growth(10, (size) => size * size)).toBe(16);
  });

  it('keeps the fastest of each size, so one slow round decides nothing', async () => {
    const times = [50, 4000, 10, 40, 10, 40, 10, 40, 10, 40];

    expect(await growth(10, () => times.shift()!)).toBe(4);
  });
});
