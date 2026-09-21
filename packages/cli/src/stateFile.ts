import { LocalBackend } from '@clay/state';
import fs from 'node:fs/promises';

/** The state file this working directory keeps. */
export function stateFile(): LocalBackend {
  return new LocalBackend(process.cwd());
}

export async function exists(file: string): Promise<boolean> {
  return fs
    .access(file)
    .then(() => true)
    .catch(() => false);
}
