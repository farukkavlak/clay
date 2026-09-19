import { IResource } from '@miniform/contracts';

import { IStateBackend } from './IStateBackend';

export interface IState {
  version: number;
  variables?: Record<string, unknown>;
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

  async write(state: IState): Promise<void> {
    await this.backend.write(state);
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
