import { State, STATE_VERSION } from '@clay/contracts';

import { journalLine } from './journal';
import { LockInfo, LockNotReleased, newLockInfo, StateLocked } from './lockInfo';
import { FIRST_PAUSE, LockWait, nextPause, NO_WAIT, REAL_TIME, Timer } from './lockWait';
import { StateBackend } from './StateBackend';

const isAbort = (error: unknown) => error instanceof Error && error.name === 'AbortError';

export class StateManager {
  private backend: StateBackend;
  private writing: Promise<void> = Promise.resolve();
  /** Set by an append that failed, which may have left part of a line; the next line would follow it. */
  private journalBroken = false;
  private lockId: string | undefined;
  private taking: Promise<void> = Promise.resolve();
  /** Set by `stop`, after which no lock is taken. */
  private stopped = false;
  /** Aborted by `stop`, which ends a wait for the lock. */
  private readonly stopping = new AbortController();

  constructor(
    backend: StateBackend,
    private readonly wait: LockWait = NO_WAIT,
    private readonly timer: Timer = REAL_TIME
  ) {
    this.backend = backend;
  }

  async read(): Promise<State> {
    return this.backend.read();
  }

  /** One at a time in the order asked, since a backend writes through one temp file; a failed write does not stop later ones. */
  write(state: State): Promise<void> {
    return this.inTurn(() => this.save(state));
  }

  /**
   * Saves what `key` holds, after an action that changed no other address. The line is taken when its turn comes and counts in the serial
   * as a write does. A backend without a journal, or one an append failed on, is written whole.
   */
  record(state: State, key: string): Promise<void> {
    const append = this.backend.append?.bind(this.backend);
    if (!append) return this.write(state);

    return this.inTurn(async () => {
      this.requireLock('A write');
      if (this.journalBroken) {
        await this.save(state);
        return;
      }

      const serial = state.serial + 1;
      try {
        await append(journalLine(state, key, serial));
      } catch (error) {
        this.journalBroken = true;
        throw error;
      }
      // eslint-disable-next-line require-atomic-updates -- the queue runs one turn at a time, and the serial moves only once the line is in place
      state.serial = serial;
    });
  }

  private inTurn(save: () => Promise<void>): Promise<void> {
    const turn = this.writing.then(save);
    this.writing = turn.catch(() => {});

    return turn;
  }

  /**
   * Copies known fields only, so a key from an older version is dropped; a new state field goes here too.
   * Bumps the serial on the given state once the write is in place, so the caller keeps writing from the serial on disk.
   * Writes this Clay's version, since the state may now hold what an older one cannot read.
   */
  private async save(state: State): Promise<void> {
    this.requireLock('A write');
    const serial = state.serial + 1;
    state.version = STATE_VERSION;
    await this.backend.write({ version: state.version, serial, outputs: state.outputs, resources: state.resources, deposed: state.deposed });
    // eslint-disable-next-line require-atomic-updates -- the queue runs one turn at a time, and the serial moves only once the write is in place
    state.serial = serial;
    this.journalBroken = false;
  }

  /** Under the lock, so a backend that cannot check and write in one step has no run write in between. */
  async writeIfAbsent(state: State): Promise<boolean> {
    this.requireLock('A write');
    return this.backend.writeIfAbsent(state);
  }

  /** `operation` names the command, so a run the lock stops can say what holds it. */
  async lock(operation: string): Promise<void> {
    if (this.stopped) throw new Error('This run is stopping, so it takes no lock');

    const info = newLockInfo(operation);
    const taken = this.take(info);
    // Waited for by unlock, so a lock still being taken is released too; a failure to take it is the caller's to see.
    this.taking = taken.catch(() => {});
    await taken;
  }

  private async take(info: LockInfo): Promise<void> {
    await this.waitedFor(info);
    this.lockId = info.id;
  }

  /** Tries again while another run holds the lock, until `wait.seconds` have passed since the first try. */
  private async waitedFor(info: LockInfo): Promise<void> {
    const until = this.timer.now() + this.wait.seconds * 1000;
    for (let pause = FIRST_PAUSE; ; pause = nextPause(pause)) {
      const locked = await this.tried(info);
      if (!locked) return;

      const left = until - this.timer.now();
      if (left <= 0) throw this.wait.seconds === 0 ? locked : new Error(`Waited ${this.wait.seconds}s for the lock. ${locked.message}`, { cause: locked });

      // A run stopped while it tried has nothing to wait for.
      if (pause === FIRST_PAUSE && !this.stopping.signal.aborted) this.wait.told(locked);
      await this.paused(Math.min(pause, left), locked);
    }
  }

  /** The lock another run holds, or undefined once this run has taken it. */
  private async tried(info: LockInfo): Promise<StateLocked | undefined> {
    try {
      await this.backend.lock(info);
      return undefined;
    } catch (error) {
      if (error instanceof StateLocked) return error;

      throw error;
    }
  }

  private async paused(ms: number, locked: StateLocked): Promise<void> {
    try {
      await this.timer.sleep(ms, this.stopping.signal);
    } catch (error) {
      if (!isAbort(error)) throw error;

      throw new Error(`Stopped waiting for the lock. ${locked.message}`, { cause: locked });
    }
  }

  /** Releases only what this manager took, once. A release that fails throws `LockNotReleased`. */
  async unlock(): Promise<void> {
    await this.taking;
    const id = this.lockId;
    if (id === undefined) return;

    this.lockId = undefined;
    try {
      await this.backend.unlock(id);
    } catch (error) {
      // Whatever stopped the release, the lock may still be held, so every failure is that one.
      throw new LockNotReleased(error);
    }
  }

  /** For a run that exits at once: ends a wait for the lock, releases it, and refuses one to work that goes on while the release is under way. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.stopping.abort();
    await this.unlock();
  }

  /** True once this manager has taken the lock, until it releases it. */
  get held(): boolean {
    return this.lockId !== undefined;
  }

  /** Refuses work on the state that the caller has not taken the lock for. */
  requireLock(what: string): void {
    if (!this.held) throw new Error(`${what} needs the state lock, and none is held`);
  }

  /** For a `catch`: releases the lock and throws `failure` again, beside the unlock's own error if that fails too. */
  async unlockAfter(failure: unknown): Promise<never> {
    try {
      await this.unlock();
    } catch (unlockError) {
      // Every unlock error is kept, so none can hide the failure.
      throw new AggregateError([failure, unlockError], 'The run failed, and its lock was not released');
    }

    throw failure;
  }
}
