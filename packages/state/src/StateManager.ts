import { State, STATE_VERSION } from '@clay/contracts';

import { journalLine } from './journal';
import { LockInfo, newLockInfo } from './lockInfo';
import { StateBackend } from './StateBackend';

export class StateManager {
  private backend: StateBackend;
  private writing: Promise<void> = Promise.resolve();
  /** Set by an append that failed, which may have left part of a line; the next line would follow it. */
  private journalBroken = false;
  private lockId: string | undefined;
  private taking: Promise<void> = Promise.resolve();

  constructor(backend: StateBackend) {
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
    const serial = state.serial + 1;
    state.version = STATE_VERSION;
    await this.backend.write({ version: state.version, serial, outputs: state.outputs, resources: state.resources, deposed: state.deposed });
    // eslint-disable-next-line require-atomic-updates -- the queue runs one turn at a time, and the serial moves only once the write is in place
    state.serial = serial;
    this.journalBroken = false;
  }

  async writeIfAbsent(state: State): Promise<boolean> {
    return this.backend.writeIfAbsent(state);
  }

  /** `operation` names the command, so a run the lock stops can say what holds it. */
  async lock(operation: string): Promise<void> {
    const info = newLockInfo(operation);
    const taken = this.take(info);
    // Waited for by unlock, so a lock still being taken is released too; a failure to take it is the caller's to see.
    this.taking = taken.catch(() => {});
    await taken;
  }

  private async take(info: LockInfo): Promise<void> {
    await this.backend.lock(info);
    this.lockId = info.id;
  }

  /** Releases only what this manager took, once. */
  async unlock(): Promise<void> {
    await this.taking;
    const id = this.lockId;
    if (id === undefined) return;

    this.lockId = undefined;
    await this.backend.unlock(id);
  }

  /** Runs `work` under the lock and releases it however `work` ends, keeping its failure. */
  async whileLocked<T>(operation: string, work: () => Promise<T>): Promise<T> {
    await this.lock(operation);
    try {
      return await work();
    } catch (error) {
      return await this.unlockAfter(error);
    } finally {
      await this.unlock();
    }
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
