import { IState } from '@clay/contracts';

/** Where the state is kept. */
export interface IStateBackend {
  read(): Promise<IState>;

  write(state: IState): Promise<void>;

  /** Writes only when none is stored yet, and says whether it did. */
  writeIfAbsent(state: IState): Promise<boolean>;

  lock(): Promise<void>;

  unlock(): Promise<void>;
}
