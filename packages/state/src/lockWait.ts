import { setTimeout as delay } from 'node:timers/promises';

import { StateLocked } from './lockInfo';

/** How long a run waits for a lock another run holds. */
export interface LockWait {
  readonly seconds: number;
  /** Called once, when the lock is first found held and the run starts to wait. */
  readonly told: (locked: StateLocked) => void;
}

export const NO_WAIT: LockWait = { seconds: 0, told: () => {} };

/** `sleep` rejects with an `AbortError` once `signal` is aborted. */
export interface Timer {
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

// Monotonic, so a change of the system clock does not move the deadline.
export const REAL_TIME: Timer = { now: () => performance.now(), sleep: (ms, signal) => delay(ms, undefined, { signal }) };

export const FIRST_PAUSE = 1000;
const LONGEST_PAUSE = 16_000;

export const nextPause = (pause: number) => Math.min(pause * 2, LONGEST_PAUSE);
