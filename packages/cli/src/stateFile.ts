import { LocalBackend, StateBackend } from '@clay/state';

export function stateFile(): StateBackend {
  return new LocalBackend(process.cwd());
}
