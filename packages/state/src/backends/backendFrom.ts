import { BackendBlock, ConfigError } from '@clay/parser';

import { StateBackend } from '../StateBackend';
import { checkNames, textOf } from './blockText';
import { httpFrom } from './httpFrom';
import { LocalBackend } from './LocalBackend';

function checkedPath(block: BackendBlock): string | undefined {
  const path = textOf(block, 'path');
  if (path === undefined) return undefined;
  // The next load would read the state as configuration, once the write had replaced what was there.
  if (path.value.toLowerCase().endsWith('.clay'))
    throw new ConfigError(`path of backend "local" is "${path.value}", and a file ending in .clay is configuration`, path.at.position);

  return path.value;
}

function localBackend(block: BackendBlock, workingDir: string): StateBackend {
  checkNames(block, ['path']);

  return new LocalBackend(workingDir, checkedPath(block));
}

/** A Map, so `toString` is no backend. */
const BACKENDS = new Map<string, (block: BackendBlock, workingDir: string) => StateBackend>([
  ['local', localBackend],
  ['http', httpFrom],
]);

/** With no block, the state is the file Clay has always kept next to the configuration. */
export function backendFrom(block: BackendBlock | undefined, workingDir: string): StateBackend {
  if (block === undefined) return new LocalBackend(workingDir);

  const make = BACKENDS.get(block.backendType.value);
  if (make === undefined)
    throw new ConfigError(`Clay has no backend "${block.backendType.value}"; it has ${[...BACKENDS.keys()].map((type) => `"${type}"`).join(', ')}`, block.backendType.position);

  return make(block, workingDir);
}
