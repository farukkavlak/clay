import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { setImmediate } from 'node:timers/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalBackend } from '../src/backends/LocalBackend';
import { LockInfo, newLockInfo, StateLocked } from '../src/lockInfo';
import { LockWait, Timer } from '../src/lockWait';
import { StateManager } from '../src/StateManager';

/** A clock that moves only when the run sleeps, or when a test moves it; `onSleep` runs after each pause. */
class FakeTime implements Timer {
  at = 0;
  readonly pauses: number[] = [];

  constructor(private readonly onSleep: (pauses: number) => Promise<void> = async () => {}) {}

  now(): number {
    return this.at;
  }

  async sleep(ms: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.pauses.push(ms);
    this.at += ms;
    await this.onSleep(this.pauses.length);
  }
}

/** A promise and the function that settles it. */
function opened(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** A manager whose tries on `backend` wait for `letGo`, and a promise that settles once the first try has started. */
function triesOnGo(backend: LocalBackend, lockWait: LockWait) {
  const lock = backend.lock.bind(backend);
  const go = opened();
  const started = opened();
  backend.lock = async (info) => {
    started.open();
    await go.promise;
    return lock(info);
  };
  return { manager: new StateManager(backend, lockWait, new FakeTime()), started: started.promise, letGo: go.open };
}

describe('a run that waits for the lock', () => {
  let dir: string;
  let told: StateLocked[];

  const lockPath = () => path.join(dir, 'clay.state.json.lock');
  const held = async () => JSON.parse(await fs.readFile(lockPath(), 'utf8')) as LockInfo;
  const holder: LockInfo = { ...newLockInfo('state rm'), created: '2026-11-07T10:00:00.000Z' };
  const wait = (seconds: number): LockWait => ({ seconds, told: (locked) => told.push(locked) });
  const managerOn = (seconds: number, time: Timer, at = dir) => new StateManager(new LocalBackend(at), wait(seconds), time);

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-lock-wait-'));
    told = [];
    await fs.writeFile(lockPath(), JSON.stringify(holder));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('is refused at once with no time to wait, as before, and told nothing', async () => {
    const time = new FakeTime();

    const taking = managerOn(0, time).lock('apply');

    await expect(taking).rejects.toThrow(StateLocked);
    await expect(taking).rejects.toThrow(/^State is locked by state rm/);
    expect(time.pauses).toEqual([]);
    expect(told).toEqual([]);
  });

  it('takes the lock once the run that held it lets it go', async () => {
    const time = new FakeTime(async (pauses) => {
      if (pauses === 2) await fs.rm(lockPath());
    });
    const manager = managerOn(60, time);

    await manager.lock('apply');

    expect(time.pauses).toEqual([1000, 2000]);
    const { operation } = await held();
    expect(operation).toBe('apply');
    expect(manager.held).toBe(true);
  });

  it('is told once, of the run that holds the lock', async () => {
    const time = new FakeTime(async (pauses) => {
      if (pauses === 3) await fs.rm(lockPath());
    });

    await managerOn(60, time).lock('apply');

    expect(told.map((locked) => locked.message)).toEqual([expect.stringMatching(/^State is locked by state rm of .* since 2026-11-07T10:00:00.000Z/)]);
  });

  it('pauses twice as long each time up to 16s, and gives up when the time is gone', async () => {
    const time = new FakeTime();

    const taking = managerOn(60, time).lock('apply');

    await expect(taking).rejects.toThrow(/^Waited 60s for the lock\. State is locked by state rm/);
    await expect(taking).rejects.toHaveProperty('cause', told[0]);
    expect(time.pauses).toEqual([1000, 2000, 4000, 8000, 16_000, 16_000, 13_000]);
    expect(await held()).toEqual(holder);
  });

  it('counts the time a try takes', async () => {
    const time = new FakeTime();
    const backend = new LocalBackend(dir);
    const lock = backend.lock.bind(backend);
    backend.lock = async (info) => {
      time.at += 7000;
      return lock(info);
    };

    await expect(new StateManager(backend, wait(10), time).lock('apply')).rejects.toThrow(/^Waited 10s for the lock/);
    expect(time.pauses).toEqual([1000]);
  });

  it('does not wait on a failure other than a held lock', async () => {
    const time = new FakeTime();

    await expect(managerOn(60, time, path.join(dir, 'missing')).lock('apply')).rejects.toThrow('ENOENT');
    expect(time.pauses).toEqual([]);
    expect(told).toEqual([]);
  });

  describe('stopped while a try is under way', () => {
    it('ends the wait on a try that finds the lock held, telling nothing', async () => {
      const { manager, started, letGo } = triesOnGo(new LocalBackend(dir), wait(60));
      const taking = manager.lock('apply');
      taking.catch(() => {});
      await started;

      const stopping = manager.stop();
      letGo();
      await stopping;

      await expect(taking).rejects.toThrow(/^Stopped waiting for the lock\. State is locked by state rm/);
      expect(told).toEqual([]);
      expect(await held()).toEqual(holder);
    });

    it('releases a lock the try took', async () => {
      await fs.rm(lockPath());
      const { manager, started, letGo } = triesOnGo(new LocalBackend(dir), wait(60));
      const taking = manager.lock('apply');
      await started;

      const stopping = manager.stop();
      letGo();
      await stopping;

      await taking;
      expect(manager.held).toBe(false);
      await expect(fs.access(lockPath())).rejects.toThrow('ENOENT');
    });
  });

  it('stops waiting when the run is stopped, and leaves the other run its lock', async () => {
    const untilAborted: Timer = {
      now: () => 0,
      sleep: (_, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason));
        }),
    };
    const manager = managerOn(60, untilAborted);
    const taking = manager.lock('apply');
    taking.catch(() => {});
    while (told.length === 0) await setImmediate();

    await manager.stop();

    await expect(taking).rejects.toThrow(/^Stopped waiting for the lock\. State is locked by state rm/);
    expect(manager.held).toBe(false);
    expect(await held()).toEqual(holder);
  });

  it('passes on a pause that fails for any other reason', async () => {
    const failing: Timer = { now: () => 0, sleep: () => Promise.reject(new Error('no timer')) };

    await expect(managerOn(60, failing).lock('apply')).rejects.toThrow('no timer');
  });
});
