import { IState } from '@clay/contracts';

import { IStateBackend } from './IStateBackend';

export class StateManager {
  private backend: IStateBackend;

  constructor(backend: IStateBackend) {
    this.backend = backend;
  }

  async read(): Promise<IState> {
    return this.backend.read();
  }

  /**
   * Named field by field, so a key an older version wrote is dropped. A field added to the state belongs here too.
   * The serial is bumped on the given state, so the caller keeps writing from the serial on disk.
   */
  async write(state: IState): Promise<void> {
    state.serial += 1;
    await this.backend.write({ version: state.version, serial: state.serial, outputs: state.outputs, resources: state.resources });
  }

  async writeIfAbsent(state: IState): Promise<boolean> {
    return this.backend.writeIfAbsent(state);
  }

  async lock(): Promise<void> {
    await this.backend.lock();
  }

  async unlock(): Promise<void> {
    await this.backend.unlock();
  }
}
