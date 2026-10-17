import { State, STATE_VERSION } from '@clay/contracts';

import { StateBackend } from './StateBackend';

export class StateManager {
  private backend: StateBackend;
  private writing: Promise<void> = Promise.resolve();

  constructor(backend: StateBackend) {
    this.backend = backend;
  }

  async read(): Promise<State> {
    return this.backend.read();
  }

  /** One at a time in the order asked, since a backend writes through one temp file; a failed write does not stop later ones. */
  write(state: State): Promise<void> {
    const turn = this.writing.then(() => this.save(state));
    this.writing = turn.catch(() => {});

    return turn;
  }

  /**
   * Copies known fields only, so a key from an older version is dropped; a new state field goes here too.
   * Bumps the serial on the given state, so the caller keeps writing from the serial on disk.
   * Writes this Clay's version, since the state may now hold what an older one cannot read.
   */
  private async save(state: State): Promise<void> {
    state.serial += 1;
    state.version = STATE_VERSION;
    await this.backend.write({ version: state.version, serial: state.serial, outputs: state.outputs, resources: state.resources });
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
