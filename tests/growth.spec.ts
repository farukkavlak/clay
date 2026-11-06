import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { growth } from './growth';

describe('growth', () => {
  const gc = vi.fn();

  beforeEach(() => {
    gc.mockClear();
    vi.stubGlobal('gc', gc);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('is about four for work that grows with its size, and sixteen for work that holds each part against every other', async () => {
    expect(await growth(10, (size) => size)).toBe(4);
    expect(await growth(10, (size) => size * size)).toBe(16);
  });

  it('keeps the fastest of each size, so one slow round decides nothing', async () => {
    const times = [50, 4000, 10, 40, 10, 40, 10, 40, 10, 40];

    expect(await growth(10, () => times.shift()!)).toBe(4);
  });

  it('collects garbage before each measure, so none pays for what the last one left', async () => {
    const collectedBefore: number[] = [];

    await growth(10, (size) => {
      collectedBefore.push(gc.mock.calls.length);
      return size;
    });

    expect(collectedBefore).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('refuses to measure where garbage cannot be collected', async () => {
    vi.stubGlobal('gc', undefined);

    await expect(growth(10, (size) => size)).rejects.toThrow('growth needs node --expose-gc');
  });
});
