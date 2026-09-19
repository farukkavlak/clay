import { IResource } from '@clay/contracts';

import { IStateBackend } from './IStateBackend';

export interface IState {
  version: number;
  /** Counts the writes. A saved plan records it, so a state written after the plan is caught. */
  serial: number;
  /** What the root module's outputs came to on the last run. */
  outputs?: Record<string, unknown>;
  resources: Record<string, IResource>;
}

/**
 * StateManager coordinates state operations through a backend.
 * This abstraction enables support for different storage backends (local, S3, Azure, etc.)
 */
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
