import { ConfigError } from './ConfigError';
import { Token } from './tokens';

/** A duplicate would silently replace the first, and `__proto__` would set a prototype, not a key. */
export function checkKey(entries: object, key: Token): void {
  if (key.value === '__proto__') throw new ConfigError('__proto__ cannot be a name', key.position);
  if (Object.hasOwn(entries, key.value)) throw new ConfigError(`${key.value} is set twice`, key.position);
}
