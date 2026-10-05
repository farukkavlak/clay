import { State } from '@clay/contracts';

export interface StateBackend {
  read(): Promise<State>;

  write(state: State): Promise<void>;

  writeIfAbsent(state: State): Promise<boolean>;

  lock(): Promise<void>;

  unlock(): Promise<void>;
}
