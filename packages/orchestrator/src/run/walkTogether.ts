import { Edges } from '@clay/graph';

/** One piece of a node's work: it gives events and returns whether it succeeded. */
export type Step<E> = () => AsyncGenerator<E, boolean>;

/** Reaching a node gives its events, then the steps it runs, or false where it cannot go on. */
export type Reach<E> = (id: string) => AsyncGenerator<E, Step<E>[] | false>;

type Work<E> = AsyncGenerator<E, Step<E>[] | boolean>;

type Pulled<E> = { work: Work<E>; step: IteratorResult<E, Step<E>[] | boolean> } | { work: Work<E>; crash: unknown };

/** Work that throws is held, not thrown, so the work running can finish first. */
async function pull<E>(work: Work<E>): Promise<Pulled<E>> {
  try {
    return { work, step: await work.next() };
  } catch (error) {
    return { work, crash: error };
  }
}

class Walk<E> {
  readonly waiting: E[] = [];
  succeeded = true;
  private readonly place: Map<string, number>;
  private readonly left: Map<string, number>;
  private readonly stepsLeft = new Map<string, number>();
  private readonly failed = new Set<string>();
  private readonly queue: { id: string; step: Step<E> }[] = [];
  private readonly owners = new Map<Work<E>, { id: string; isStep: boolean }>();
  /** Each piece of work with a pull in flight, which lands in `settled`. */
  private readonly pending = new Map<Work<E>, Promise<void>>();
  private readonly settled: Pulled<E>[] = [];
  private wake?: () => void;
  private stepsRunning = 0;
  private crash?: { at: number; error: unknown };

  constructor(
    private readonly order: string[],
    private readonly edges: Edges,
    private readonly reach: Reach<E>,
    private readonly limit: number,
    private readonly deferred: (event: E) => boolean
  ) {
    this.place = new Map(order.map((id, index) => [id, index]));
    this.left = new Map(order.map((id) => [id, edges.dependenciesOf(id).length]));
  }

  begin(): void {
    this.reachAll(this.order.filter((id) => this.left.get(id) === 0));
  }

  idle(): boolean {
    return this.pending.size === 0 && this.settled.length === 0;
  }

  async next(): Promise<Pulled<E>> {
    while (this.settled.length === 0)
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });

    return this.settled.shift()!;
  }

  /** What a piece of work came to: done, crashed, or an event, which is held or given to the reader. */
  receive(pulled: Pulled<E>): { give: E } | undefined {
    if ('crash' in pulled) this.crashed(pulled.work, pulled.crash);
    else if (pulled.step.done) this.ended(pulled.work, pulled.step.value);
    else {
      this.watch(pulled.work);
      if (!this.deferred(pulled.step.value)) return { give: pulled.step.value };

      this.waiting.push(pulled.step.value);
    }

    return undefined;
  }

  throwCrash(): void {
    if (this.crash) throw this.crash.error;
  }

  async settle(): Promise<void> {
    await Promise.allSettled(this.pending.values());
  }

  /** In the order, and none once something crashed. */
  private reachAll(ids: string[]): void {
    for (const id of ids.sort((one, other) => this.place.get(one)! - this.place.get(other)!)) {
      if (this.crash) return;

      this.track(this.reach(id), id, false);
    }
  }

  private track(work: Work<E>, id: string, isStep: boolean): void {
    this.owners.set(work, { id, isStep });
    this.watch(work);
  }

  private watch(work: Work<E>): void {
    this.pending.set(work, this.land(work));
  }

  private async land(work: Work<E>): Promise<void> {
    this.settled.push(await pull(work));
    this.pending.delete(work);
    this.wake?.();
  }

  private crashed(work: Work<E>, error: unknown): void {
    const { id, isStep } = this.owners.get(work)!;
    this.owners.delete(work);
    if (isStep) this.stepsRunning -= 1;

    const at = this.place.get(id)!;
    if (!this.crash || at < this.crash.at) this.crash = { at, error };
    this.succeeded = false;
  }

  private ended(work: Work<E>, value: Step<E>[] | boolean): void {
    const { id, isStep } = this.owners.get(work)!;
    this.owners.delete(work);

    if (isStep) this.stepEnded(id, value === true);
    else this.reached(id, Array.isArray(value) ? value : false);
  }

  private reached(id: string, steps: Step<E>[] | false): void {
    if (steps === false || steps.length === 0) {
      this.finish(id, steps !== false);
      return;
    }

    this.stepsLeft.set(id, steps.length);
    for (const step of steps) this.queue.push({ id, step });
    this.fill();
  }

  private stepEnded(id: string, succeeded: boolean): void {
    this.stepsRunning -= 1;
    if (!succeeded) this.failed.add(id);

    const left = this.stepsLeft.get(id)! - 1;
    this.stepsLeft.set(id, left);
    if (left === 0) this.finish(id, !this.failed.has(id));
    this.fill();
  }

  /** Starts steps while there is room, and none once something crashed. */
  private fill(): void {
    while (!this.crash && this.stepsRunning < this.limit && this.queue.length > 0) {
      const { id, step } = this.queue.shift()!;
      this.stepsRunning += 1;
      this.track(step(), id, true);
    }
  }

  /** What depends on a node that failed is never reached, nor what depends on that. */
  private finish(id: string, succeeded: boolean): void {
    if (!succeeded) {
      this.succeeded = false;
      return;
    }

    const ready = this.edges.dependentsOf(id).filter((dependent) => {
      this.left.set(dependent, this.left.get(dependent)! - 1);
      return this.left.get(dependent) === 0;
    });
    this.reachAll(ready);
  }
}

/**
 * Reaches each node once every node it depends on has run all its steps, and runs the steps of all nodes `limit` at a time.
 * A step that fails, or a node that cannot go on, keeps what depends on it from being reached; the rest goes on, and the walk returns false.
 * Once anything throws, nothing starts, and the first throw in `order` is thrown after the running work is done.
 * An event `deferred` holds is given only once nothing runs, so a reader that stops at it cannot cut a step short.
 */
export async function* walkTogether<E>(order: string[], edges: Edges, reach: Reach<E>, limit: number, deferred: (event: E) => boolean): AsyncGenerator<E, boolean> {
  const walk = new Walk(order, edges, reach, limit, deferred);

  try {
    walk.begin();
    while (!walk.idle()) {
      const received = walk.receive(await walk.next());
      if (received) yield received.give;
    }

    yield* walk.waiting;
    walk.throwCrash();
  } finally {
    // A reader that leaves early still waits for the work already started.
    await walk.settle();
  }

  return walk.succeeded;
}
