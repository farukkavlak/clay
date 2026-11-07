import { AttributeValue, namedIn } from './ast';
import { ConfigError } from './ConfigError';
import { spellNamed } from './reference';

export function checkConstant(value: AttributeValue, what: string): void {
  const [named] = namedIn(value);
  if (named) throw new ConfigError(`${what} is a constant, so it cannot hold ${spellNamed(named)}`, named.position);
}
