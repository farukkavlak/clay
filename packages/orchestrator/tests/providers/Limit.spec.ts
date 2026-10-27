import { describe, expect, it } from 'vitest';

import { inOrder, Limit } from '../../src/providers/Limit';

const pause = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

describe('a limit', () => {
  it('runs as many at once as it allows, and starts the rest in the order they came', async () => {
    const limit = new Limit(2);
    const log: string[] = [];
    let running = 0;
    let most = 0;
    const work = (name: string, ms: number) =>
      limit.run(async () => {
        running += 1;
        most = Math.max(most, running);
        log.push(name);
        await pause(ms);
        running -= 1;
        return name;
      });

    const done = await Promise.all([work('a', 20), work('b', 5), work('c', 5), work('d', 5)]);

    expect({ most, log, done }).toEqual({ most: 2, log: ['a', 'b', 'c', 'd'], done: ['a', 'b', 'c', 'd'] });
  });

  it('gives back the place of work that fails', async () => {
    const limit = new Limit(1);

    await expect(limit.run(() => Promise.reject(new Error('broke')))).rejects.toThrow('broke');
    expect(await limit.run(async () => 'next')).toBe('next');
  });
});

describe('work waited for in order', () => {
  it('throws the first failure in the order given, not the first to end', async () => {
    const late = pause(20).then(() => {
      throw new Error('first');
    });
    const early = Promise.reject(new Error('second'));

    await expect(inOrder([late, early])).rejects.toThrow('first');
  });

  it('gives what each piece of work came to, in the order given', async () => {
    expect(await inOrder([pause(10).then(() => 'a'), Promise.resolve('b')])).toEqual(['a', 'b']);
  });
});
