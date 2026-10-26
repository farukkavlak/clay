import { State } from '@clay/contracts';

export interface StateBackend {
  read(): Promise<State>;

  /** Replaces the state and every line appended since. */
  write(state: State): Promise<void>;

  /** Adds a line of the journal over the state last written; a backend without one is written whole instead. */
  append?(line: string): Promise<void>;

  writeIfAbsent(state: State): Promise<boolean>;

  lock(): Promise<void>;

  unlock(): Promise<void>;
}
