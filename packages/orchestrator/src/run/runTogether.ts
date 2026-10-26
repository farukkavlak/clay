type Task<E> = AsyncGenerator<E, boolean>;

type Pulled<E> = { task: Task<E>; step: IteratorResult<E, boolean> } | { task: Task<E>; crash: unknown };

/** A task that throws is held, not thrown, so the ones running can finish first. */
async function pull<E>(task: Task<E>): Promise<Pulled<E>> {
  try {
    return { task, step: await task.next() };
  } catch (error) {
    return { task, crash: error };
  }
}

interface Run<E> {
  running: Map<Task<E>, Promise<Pulled<E>>>;
  /** Events `deferred` says wait until nothing runs. */
  waiting: E[];
  crashes: unknown[];
  succeeded: boolean;
  started: number;
}

/** Starts tasks while there is room, and none once one has failed. */
function fill<E>(run: Run<E>, starts: (() => Task<E>)[], limit: number): void {
  while (run.succeeded && run.started < starts.length && run.running.size < limit) {
    const task = starts[run.started++]();
    run.running.set(task, pull(task));
  }
}

/** What a task came to: gone, crashed, or an event, which is held or given to the reader. */
function receive<E>(run: Run<E>, pulled: Pulled<E>, deferred: (event: E) => boolean): { give: E } | undefined {
  if ('crash' in pulled) {
    run.running.delete(pulled.task);
    run.crashes.push(pulled.crash);
    run.succeeded = false;
  } else if (pulled.step.done) {
    run.running.delete(pulled.task);
    run.succeeded &&= pulled.step.value;
  } else {
    run.running.set(pulled.task, pull(pulled.task));
    if (!deferred(pulled.step.value)) return { give: pulled.step.value };

    run.waiting.push(pulled.step.value);
  }

  return undefined;
}

/**
 * Runs the tasks `limit` at a time and gives their events as they come.
 * Once a task returns false or throws, none starts and the ones running finish.
 * An event `deferred` says so for waits until nothing runs, so a reader that stops at it cannot cut a task short.
 * Returns false when a task did, and throws the first crash after the rest are done.
 */
export async function* runTogether<E>(starts: (() => Task<E>)[], limit: number, deferred: (event: E) => boolean): Task<E> {
  const run: Run<E> = { running: new Map(), waiting: [], crashes: [], succeeded: true, started: 0 };

  try {
    for (fill(run, starts, limit); run.running.size > 0; fill(run, starts, limit)) {
      const received = receive(run, await Promise.race(run.running.values()), deferred);
      if (received) yield received.give;
    }

    yield* run.waiting;
    if (run.crashes.length > 0) throw run.crashes[0];
  } finally {
    // A reader that leaves early still waits for the work already started.
    await Promise.allSettled(run.running.values());
  }

  return run.succeeded;
}
