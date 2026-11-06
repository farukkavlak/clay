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

/** For work that writes no state, as a plan: Ctrl-C releases the lock `manager` holds and exits at once, with nothing to wait for. */
export async function stoppedAtOnce<T>(manager: StateManager, work: () => Promise<T>): Promise<T> {
  const onInterrupt = async () => {
    console.error(styleText('yellow', '\nInterrupted. Nothing was written.'));
    try {
      await manager.unlock();
    } catch (error) {
      // Every error is reported and none rethrown: in a signal handler a rethrow is an unhandled rejection, and the process exits either way.
      reportLockLeft(error);
    }
    process.exit(INTERRUPTED);
  };

  process.on('SIGINT', onInterrupt);
  try {
    return await work();
  } finally {
    process.off('SIGINT', onInterrupt);
  }
}
