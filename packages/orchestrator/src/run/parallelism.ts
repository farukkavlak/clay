/** How many actions, or calls to providers, run at once, unless the caller says. */
export const DEFAULT_PARALLELISM = 10;

export interface Pace {
  parallelism: number;
  signal?: AbortSignal;
}

/** 0, a fraction or NaN would stall or break the run, so they are refused where they come in. */
export function checkParallelism(parallelism: number): void {
  if (!Number.isInteger(parallelism) || parallelism < 1) throw new Error(`parallelism is a whole number from 1, not ${parallelism}`);
}

/** At most `size` pieces of work at once; the rest wait their turn in the order they came. */
export class Limit {
  private running = 0;
  private readonly waiting: (() => void)[] = [];

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

/** Waits for every piece of work and throws the first failure in the order given, so which one is reported does not depend on timing. */
export async function inOrder<T>(work: Promise<T>[]): Promise<T[]> {
  const settled = await Promise.allSettled(work);
  const failed = settled.find((each): each is PromiseRejectedResult => each.status === 'rejected');
  if (failed) throw failed.reason;

  return settled.flatMap((each) => (each.status === 'fulfilled' ? [each.value] : []));
}
