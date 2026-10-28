import { describe, expect, it } from 'vitest';

import { Queue } from '../src/Queue';

/** Everything left in `queue`, taken in turn. */
function drained<T>(queue: Queue<T>): T[] {
  const taken: T[] = [];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) taken.push(next);
  return taken;
}

describe('a queue', () => {
  it('gives its items in the order they came, the first given to it before any added', () => {
    const queue = new Queue(['a', 'b']);
    queue.push('c');

    expect(drained(queue)).toEqual(['a', 'b', 'c']);
  });

  it('gives nothing once empty, and its length counts what is left', () => {
    const queue = new Queue([1, 2, 3]);
    queue.shift();

    expect(queue.length).toBe(2);
    drained(queue);
    expect({ next: queue.shift(), length: queue.length }).toEqual({ next: undefined, length: 0 });
  });

  it('keeps the order of items added while others are taken', () => {
    const queue = new Queue<number>();
    const taken: number[] = [];
    for (let item = 0; item < 10; item++) {
      for (const added of [item, item + 100]) queue.push(added);
      taken.push(queue.shift()!);
    }

    expect([...taken, ...drained(queue)]).toEqual(Array.from({ length: 10 }, (_, item) => [item, item + 100]).flat());
  });

  it('is not changed by a change to the list it was given', () => {
    const items = ['a'];
    const queue = new Queue(items);
    items.push('b');

    expect(drained(queue)).toEqual(['a']);
  });
});
