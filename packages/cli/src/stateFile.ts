import { LocalBackend } from '@miniform/state';
import path from 'node:path';

/** A path given on the command line names a file, and the backend takes a directory and a name, so it is split here. */
export function stateBackend(statePath: string | undefined): LocalBackend {
  if (!statePath) return new LocalBackend(process.cwd());

  const file = path.resolve(process.cwd(), statePath);

  return new LocalBackend(path.dirname(file), path.basename(file));
}
