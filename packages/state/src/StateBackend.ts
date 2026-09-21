import { State } from '@clay/contracts';

/** Where the state is kept. */
export interface StateBackend {
  read(): Promise<State>;

  write(state: State): Promise<void>;

  /** Writes only when none is stored yet, and says whether it did. */
  writeIfAbsent(state: State): Promise<boolean>;

  lock(): Promise<void>;

  unlock(): Promise<void>;
}
