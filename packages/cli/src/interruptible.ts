import { StateManager } from '@clay/state';
import { styleText } from 'node:util';

import { reportLockLeft } from './released';

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

/** The process exits before it settles. */
const untilExit = () => new Promise<never>(() => {});

/**
 * For work that writes no state, as a plan: Ctrl-C releases the locks `managers` hold and exits at once, with nothing to wait for. The work
 * goes on while the release is under way, and what it gives then is not used.
 */
export async function stoppedAtOnce<T>(managers: readonly StateManager[], work: () => Promise<T>): Promise<T> {
  let interrupted = false;
  const onInterrupt = async () => {
    interrupted = true;
    console.error(styleText('yellow', '\nInterrupted. Nothing was written.'));
    // Every error is reported and none rethrown: in a signal handler a rethrow is an unhandled rejection, and the process exits either way.
    const released = await Promise.allSettled(managers.map((manager) => manager.stop()));
    for (const result of released) if (result.status === 'rejected') reportLockLeft(result.reason);
    process.exit(INTERRUPTED);
  };

  process.on('SIGINT', onInterrupt);
  try {
    const value = await work();
    return interrupted ? await untilExit() : value;
  } catch (error) {
    if (interrupted) return await untilExit();

    throw error;
  } finally {
    process.off('SIGINT', onInterrupt);
  }
}
