import { State, STATE_VERSION } from '@clay/contracts';

import { StateBackend } from './StateBackend';

export class StateManager {
  private backend: StateBackend;

  constructor(backend: StateBackend) {
    this.backend = backend;
  }

  async read(): Promise<State> {
    return this.backend.read();
  }

  /**
   * Copies known fields only, so a key from an older version is dropped; a new state field goes here too.
   * Bumps the serial on the given state, so the caller keeps writing from the serial on disk.
   * Writes this Clay's version, since the state may now hold what an older one cannot read.
   */
  async write(state: State): Promise<void> {
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
