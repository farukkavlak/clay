import { Settings } from './settings';
import { checkNotBeside, checkNotWorkspaceState, LOCK_BESIDE } from './workspaces';

/** An object store lists a key ending in "/" as a folder, and one with an empty part names another object than the path it reads as. Returns the key's parts. */
export function checkObjectKey(settings: Settings, key: string): readonly string[] {
  const of = `key of backend "${settings.type}" is "${key}"`;
  if (key.startsWith('/') || key.endsWith('/')) settings.refuse(`${of}, which must not start or end with "/"`, 'key');
  if (key.includes('//')) settings.refuse(`${of}, which must not hold "//"`, 'key');
  const parts = key.split('/');
  checkNotBeside(settings, 'key', key, parts, LOCK_BESIDE);
  checkNotWorkspaceState(settings, 'key', key, parts);

  return parts;
}
