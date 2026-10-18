import { styleText } from 'node:util';

/** The exit code of a process stopped by SIGINT: 128 plus the signal's number. */
export const INTERRUPTED = 130;

/**
 * Runs work that holds the state lock. The first Ctrl-C aborts the signal, so the work stops between actions and its `finally` unlocks;
 * the second exits at once.
 */
export async function interruptible<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const onInterrupt = () => {
    if (controller.signal.aborted) {
      console.error(styleText('red', 'Second interrupt. Exiting now: what was running may be missing from the state, and the lock is left.'));
      process.exit(INTERRUPTED);
    }

    console.error(styleText('yellow', '\nInterrupt received. Starting nothing new and waiting for what runs; Ctrl-C again exits at once.'));
    controller.abort();
  };

  process.on('SIGINT', onInterrupt);
  try {
    return await work(controller.signal);
  } finally {
    process.off('SIGINT', onInterrupt);
  }
}
