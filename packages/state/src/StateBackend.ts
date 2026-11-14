import { State } from '@clay/contracts';

import { LockInfo } from './lockInfo';

/** Kept where the state was before workspaces, so a configuration that names none goes on as it did. */
export const DEFAULT_WORKSPACE = 'default';

/** What `init` remembers, so a later command can tell the configuration has moved the state. */
export interface BackendChoice {
  readonly type: string;
  /** The same wherever the directory is moved to. */
  readonly where: string;
  /** Every setting the backend runs on, with the defaults filled in, so `init` can build it again. */
  readonly settings: Readonly<Record<string, string | number | boolean>>;
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

  /** Adds lines of the journal, each ending in a newline, over the state last written; a backend without one is written whole instead. */
  append?(lines: string): Promise<void>;

  /** Called under the lock. */
  writeIfAbsent(state: State): Promise<boolean>;

  /** Throws `StateLocked` while another run holds it. */
  lock(info: LockInfo): Promise<void>;

  /** Releases the lock taken with `id`, and no other. */
  unlock(id: string): Promise<void>;

  /** Releases lock `id` whatever run took it, for one that is gone. Throws where no lock is held, or another one. */
  forceUnlock(id: string): Promise<void>;

  /** The backend of workspace `name`, the same whichever workspace it is called on. Absent where the backend keeps a single state. */
  workspace?(name: string): StateBackend;

  /** The workspaces whose state exists, `default` first and always. Present wherever `workspace` is. */
  listWorkspaces?(): Promise<string[]>;

  /** Makes the place the state of a new workspace goes in, where one must be made. */
  prepare?(): Promise<void>;
}
