import { State } from '@clay/contracts';

import { LockInfo } from './lockInfo';

/** What `init` remembers, so a later command can tell the configuration has moved the state. */
export interface BackendChoice {
  readonly type: string;
  /** The same wherever the workspace is moved to. */
  readonly where: string;
}

export interface StateBackend {
  /** Where the state lives, as a message names it. */
  readonly location: string;

  readonly choice: BackendChoice;

  /** Refuses a place no state can be kept in, saying why. */
  check(): Promise<void>;

  /** Whether a state was ever written, which `read` cannot tell from an empty one. */
  exists(): Promise<boolean>;

  read(): Promise<State>;

  /** Replaces the state and every line appended since. */
  write(state: State): Promise<void>;

  /** Adds a line of the journal over the state last written; a backend without one is written whole instead. */
  append?(line: string): Promise<void>;

  /** Called under the lock. */
  writeIfAbsent(state: State): Promise<boolean>;

  /** Throws `StateLocked` while another run holds it. */
  lock(info: LockInfo): Promise<void>;

  /** Releases the lock taken with `id`, and no other. */
  unlock(id: string): Promise<void>;
}
