import { LocalBackend } from '@clay/state';

/** The state file this working directory keeps. */
export function stateFile(): LocalBackend {
  return new LocalBackend(process.cwd());
}
