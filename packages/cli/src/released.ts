import { LockNotReleased, StateManager } from '@clay/state';
import { styleText } from 'node:util';

import { messageOf } from './printable';

export function reportLockLeft(error: unknown): void {
  console.error(styleText('red', 'The lock could not be released:'), messageOf(error));
}

/**
 * Runs `work`, which takes the lock of `manager`, and releases the lock however it ends. A lock left after work that finished is reported
 * after what the work printed, not in place of it, and the command exits 1. Returns the exit code.
 */
export async function releasedAfter(manager: StateManager, work: () => Promise<number>): Promise<number> {
  let code: number;
  try {
    code = await work();
  } catch (error) {
    return await manager.unlockAfter(error);
  }

  try {
    await manager.unlock();
    return code;
  } catch (error) {
    if (!(error instanceof LockNotReleased)) throw error;

    reportLockLeft(error);
    return code === 0 ? 1 : code;
  }
}
