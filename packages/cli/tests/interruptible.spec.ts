import { StateManager } from '@clay/state';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { INTERRUPTED, stoppedAtOnce } from '../src/interruptible';

/** Work that ends or fails when the test says. */
function controlled() {
  let finish: (() => void) | undefined;
  let fail: (() => void) | undefined;
  const work = new Promise<string>((resolve, reject) => {
    finish = () => resolve('planned');
    fail = () => reject(new Error('This run is stopping, so it takes no lock'));
  });

  return { work, finish: () => finish?.(), fail: () => fail?.() };
}

describe('stoppedAtOnce', () => {
  let printed: ReturnType<typeof vi.spyOn>;
  let exit: ReturnType<typeof vi.spyOn>;
  let listening: NodeJS.SignalsListener[];

  beforeEach(() => {
    printed = vi.spyOn(console, 'error').mockImplementation(() => {});
    exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    listening = process.listeners('SIGINT');
  });

  afterEach(() => {
    // Work stopped by Ctrl-C never returns to remove its handler, as the process has exited.
    for (const listener of process.listeners('SIGINT')) if (!listening.includes(listener)) process.off('SIGINT', listener);
    printed.mockRestore();
    exit.mockRestore();
  });

  it.each([
    ['ends', (run: ReturnType<typeof controlled>) => run.finish()],
    ['fails', (run: ReturnType<typeof controlled>) => run.fail()],
  ])('gives nothing back from work that %s after Ctrl-C, and exits once the lock is released', async (_title, end) => {
    const manager = { stop: vi.fn().mockResolvedValue(undefined) } as Partial<StateManager> as StateManager;
    const run = controlled();
    let settled = false;
    void stoppedAtOnce(manager, () => run.work).finally(() => {
      settled = true;
    });

    process.emit('SIGINT', 'SIGINT');
    end(run);

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(INTERRUPTED));
    await sleep(20);
    expect(manager.stop).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
  });
});
