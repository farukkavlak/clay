import { Queue } from '../Queue';

/** At most `size` pieces of work at once; the rest wait their turn in the order they came. */
export class Limit {
  private running = 0;
  private readonly waiting = new Queue<() => void>();

  constructor(private readonly size: number) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.running < this.size) this.running += 1;
    else
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve);
      });

    try {
      return await work();
    } finally {
      // The place passes to the next in line, or is given up.
      const next = this.waiting.shift();
      if (next) next();
      else this.running -= 1;
    }
  }
}

/** What a piece of work came to, or its failure thrown, so work started together is taken one at a time in order. */
export function taken<T>(settled: PromiseSettledResult<T>): T {
  if (settled.status === 'rejected') throw settled.reason;

  return settled.value;
}

/** Waits for every piece of work and throws the first failure in the order given, so which one is reported does not depend on timing. */
export async function inOrder<T>(work: Promise<T>[]): Promise<T[]> {
  const settled = await Promise.allSettled(work);
  return settled.map((each) => taken(each));
}
