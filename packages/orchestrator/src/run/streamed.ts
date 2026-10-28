/** Runs `work`, giving each event it emits as it comes, and then what it returns or throws. A reader that leaves early still waits for the work. */
export async function* streamed<E, R>(work: (emit: (event: E) => void) => Promise<R>): AsyncGenerator<E, R> {
  const queue: E[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  const emit = (event: E) => {
    queue.push(event);
    wake?.();
  };
  // Settled, not awaited, so a throw before the reader comes back is not left unhandled.
  const outcome = Promise.allSettled([work(emit)]).then(([result]) => {
    ended = true;
    wake?.();
    return result;
  });

  try {
    while (queue.length > 0 || !ended) {
      if (queue.length === 0)
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      while (queue.length > 0) yield queue.shift()!;
    }
  } finally {
    wake = undefined;
    await outcome;
  }

  const result = await outcome;
  if (result.status === 'rejected') throw result.reason;
  return result.value;
}
