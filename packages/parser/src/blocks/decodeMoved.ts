import { Address, ModuleAddress, parseMovable } from '@clay/contracts';

import { AttributeValue, MovedBlock } from '../ast';
import { Attribute, Block } from '../body';
import { ConfigError } from '../ConfigError';
import { spellReference } from '../reference';
import { attributesIn } from './attributes';

const ENDPOINT = 'is a resource, a module call or an instance of either, as in local_file.a, local_file.a[0], module.m or module.m[0]';

/** Checked as it is read. */
export function checkMovedArgument({ name, value }: Attribute): void {
  if (name !== 'from' && name !== 'to') throw new ConfigError(`moved takes only "from" and "to", not "${name}".`, value.position);
}

/** Written out, since the move is made before any value is known. */
function endpointOf(value: AttributeValue, name: string): Address | ModuleAddress {
  const refuse = (reason: string): never => {
    throw new ConfigError(`moved "${name}" ${reason}`, value.position);
  };
  if (value.type !== 'Reference') return refuse(ENDPOINT);

  return parseMovable(spellReference(value.value), () => refuse(ENDPOINT));
}

export function decodeMoved(block: Block): MovedBlock {
  const { from, to } = attributesIn(block.body);
  if (from === undefined || to === undefined) throw new ConfigError(`moved needs ${from ? 'a "to"' : 'a "from"'}`, block.position);

  const source = endpointOf(from, 'from');
  const destination = endpointOf(to, 'to');
  if (source.toString() === destination.toString()) throw new ConfigError(`moved from ${source} to the same address moves nothing`, block.position);
  if (source instanceof ModuleAddress && destination instanceof ModuleAddress) return { type: 'Moved', kind: 'module', from: source, to: destination, position: block.position };
  if (source instanceof ModuleAddress || destination instanceof ModuleAddress)
    throw new ConfigError(`moved from ${source} to ${destination} names a module on one side and a resource on the other`, to.position);
  // The type decides the provider, and no provider can take an object of another type.
  if (source.resourceType !== destination.resourceType) throw new ConfigError(`moved from ${source} to ${destination} changes the type`, to.position);

  return { type: 'Moved', kind: 'resource', from: source, to: destination, position: block.position };
}
