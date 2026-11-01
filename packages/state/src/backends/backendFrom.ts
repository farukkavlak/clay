import { BackendBlock, ConfigError } from '@clay/parser';

import { StateBackend } from '../StateBackend';
import { LocalBackend } from './LocalBackend';

function checkedPath({ attributes: { path } }: BackendBlock): string | undefined {
  if (path === undefined) return undefined;
  if (path.type !== 'String') throw new ConfigError('path of backend "local" is a string written out', path.position);
  if (path.value === '') throw new ConfigError('path of backend "local" must not be empty', path.position);
  // The next load would read the state as configuration, once the write had replaced what was there.
  if (path.value.toLowerCase().endsWith('.clay')) throw new ConfigError(`path of backend "local" is "${path.value}", and a file ending in .clay is configuration`, path.position);

  return path.value;
}

function localBackend(block: BackendBlock, workingDir: string): StateBackend {
  for (const [name, value] of Object.entries(block.attributes)) if (name !== 'path') throw new ConfigError(`backend "local" takes only "path", not "${name}"`, value.position);

  return new LocalBackend(workingDir, checkedPath(block));
}

/** A Map, so `toString` is no backend. */
const BACKENDS = new Map([['local', localBackend]]);

/** With no block, the state is the file Clay has always kept next to the configuration. */
export function backendFrom(block: BackendBlock | undefined, workingDir: string): StateBackend {
  if (block === undefined) return new LocalBackend(workingDir);

  const make = BACKENDS.get(block.backendType.value);
  if (make === undefined)
    throw new ConfigError(`Clay has no backend "${block.backendType.value}"; it has ${[...BACKENDS.keys()].map((type) => `"${type}"`).join(', ')}`, block.backendType.position);

  return make(block, workingDir);
}
