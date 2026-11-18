import path from 'node:path';

import { StateBackend } from '../StateBackend';
import { azureFrom } from './azureFrom';
import { httpFrom } from './httpFrom';
import { LocalBackend } from './LocalBackend';
import { s3From } from './s3From';
import { checkNames, Environment, Settings } from './settings';
import { checkNotBeside, checkNotWorkspaceState, LOCK_BESIDE, workspaceAt } from './workspaces';

const BESIDE_A_FILE = [...LOCK_BESIDE, '.bak', '.journal', '.tmp'];

/** The state next to the configuration, which a directory inside another's folder of workspaces would share. */
export function defaultLocal(workingDir: string): LocalBackend {
  const backend = new LocalBackend(workingDir);
  const workspace = workspaceAt(backend.location.split(path.sep));
  if (workspace !== undefined)
    throw new Error(`${backend.location} is where Clay keeps the state of workspace "${workspace}"; run Clay elsewhere, or name another path in a backend block`);

  return backend;
}

function localFrom(settings: Settings, workingDir: string): StateBackend {
  checkNames(settings, ['path']);

  const file = settings.text('path');
  if (file === undefined) return defaultLocal(workingDir);

  // The next load would read the state as configuration, once the write had replaced what was there.
  if (file.toLowerCase().endsWith('.clay')) settings.refuse(`path of backend "local" is "${file}", and a file ending in .clay is configuration`, 'path');

  const parts = path.resolve(workingDir, file).split(path.sep);
  checkNotBeside(settings, 'path', file, parts, BESIDE_A_FILE);
  checkNotWorkspaceState(settings, 'path', file, parts);

  return new LocalBackend(workingDir, file);
}

/** A Map, so `toString` is no backend. */
const BACKENDS = new Map<string, (settings: Settings, workingDir: string, env: Environment) => StateBackend>([
  ['local', localFrom],
  ['http', httpFrom],
  ['s3', s3From],
  ['azure', azureFrom],
]);

export function build(settings: Settings, workingDir: string, env: Environment): StateBackend {
  const make = BACKENDS.get(settings.type);
  if (make === undefined) settings.refuse(`Clay has no backend "${settings.type}"; it has ${[...BACKENDS.keys()].map((type) => `"${type}"`).join(', ')}`);

  return make(settings, workingDir, env);
}
