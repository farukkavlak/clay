import { LockNotReleased, StateManager } from '@clay/state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { releasedAfter } from '../src/released';

/** A manager whose release fails with `failure`. */
const failingRelease = (failure: Error) => ({ unlock: vi.fn().mockRejectedValue(failure) }) as Partial<StateManager> as StateManager;

describe('releasedAfter', () => {
  let printed: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    printed = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    printed.mockRestore();
  });

  it('keeps the exit code of work that stopped, where the lock is left after it', async () => {
    const manager = failingRelease(new LockNotReleased(new Error('the server is gone')));

    expect(await releasedAfter(manager, async () => 130)).toBe(130);
    expect(printed).toHaveBeenCalledWith(expect.stringContaining('The lock could not be released:'), 'the server is gone');
  });

  it('throws an error of the release that is not a lock left', async () => {
    const failure = new TypeError('not a lock left');

    await expect(releasedAfter(failingRelease(failure), async () => 0)).rejects.toBe(failure);
    expect(printed).not.toHaveBeenCalled();
  });
});
