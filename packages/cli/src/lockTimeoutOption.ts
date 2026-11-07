import { LockWait } from '@clay/state';
import { InvalidArgumentError, Option } from 'commander';
import { styleText } from 'node:util';

import { messageOf } from './printable';

const LONGEST = 3600;

function parseLockTimeout(value: string): number {
  if (/^(0|[1-9]\d*)$/.test(value) && Number(value) <= LONGEST) return Number(value);

  throw new InvalidArgumentError(`--lock-timeout is a whole number of seconds from 0 to ${LONGEST}`);
}

export function lockTimeoutOption(): Option {
  return new Option('--lock-timeout <seconds>', 'How long to wait for a lock another run holds (default: 0)').argParser(parseLockTimeout);
}

/** Says once what holds the lock and how long the run waits for it. */
export function lockWait(seconds = 0): LockWait {
  return {
    seconds,
    told: (locked) => console.error(styleText('yellow', `${messageOf(locked)}\nWaiting up to ${seconds}s for it to be released...`)),
  };
}
