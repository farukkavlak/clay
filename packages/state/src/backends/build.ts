import { StateBackend } from '../StateBackend';
import { httpFrom } from './httpFrom';
import { LocalBackend } from './LocalBackend';
import { checkNames, Settings } from './settings';

function localFrom(settings: Settings, workingDir: string): StateBackend {
  checkNames(settings, ['path']);

  const path = settings.text('path');
  // The next load would read the state as configuration, once the write had replaced what was there.
  if (path?.toLowerCase().endsWith('.clay')) settings.refuse(`path of backend "local" is "${path}", and a file ending in .clay is configuration`, 'path');

  return new LocalBackend(workingDir, path);
}

/** A Map, so `toString` is no backend. */
const BACKENDS = new Map<string, (settings: Settings, workingDir: string) => StateBackend>([
  ['local', localFrom],
  ['http', httpFrom],
]);

export function build(settings: Settings, workingDir: string): StateBackend {
  const make = BACKENDS.get(settings.type);
  if (make === undefined) settings.refuse(`Clay has no backend "${settings.type}"; it has ${[...BACKENDS.keys()].map((type) => `"${type}"`).join(', ')}`);

  return make(settings, workingDir);
}
