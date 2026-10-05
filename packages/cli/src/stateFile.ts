import { LocalBackend } from '@clay/state';

export function stateFile(): LocalBackend {
  return new LocalBackend(process.cwd());
}
