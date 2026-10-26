import { State, STATE_VERSION } from '@clay/contracts';

import { journalLine } from './journal';
import { StateBackend } from './StateBackend';

export class StateManager {
  private backend: StateBackend;
  private writing: Promise<void> = Promise.resolve();
  /** Set by an append that failed, which may have left part of a line; the next line would follow it. */
  private journalBroken = false;

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

  async lock(): Promise<void> {
    await this.backend.lock();
  }

  async unlock(): Promise<void> {
    await this.backend.unlock();
  }
}
