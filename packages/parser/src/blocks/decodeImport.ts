import { Address } from '@clay/contracts';

import { AttributeValue, ImportBlock, ImportKey, namedIn } from '../ast';
import { Attribute, Block } from '../body';
import { ConfigError } from '../ConfigError';
import { parseReference, spellReference } from '../reference';
import { attributesIn } from './attributes';

const TARGET = 'is a resource of the root module or an instance of one, as in local_file.a or local_file.a[0]';
const ARGUMENTS = new Set(['to', 'id', 'for_each']);

/** Checked as it is read. */
export function checkImportArgument({ name, value }: Attribute): void {
  if (!ARGUMENTS.has(name)) throw new ConfigError(`import takes only "to", "id" and "for_each", not "${name}".`, value.position);
}

/** A key read from a value reads only `each`, so the resource is known before any value is. */
function keyOf(step: { index: AttributeValue; spelled: string }): ImportKey {
  for (const named of namedIn(step.index))
    if (named.type === 'Reference' && parseReference(named.value, named.position).kind !== 'each')
      throw new ConfigError('import "to" reads only each in its key, as in local_file.a[each.key]', named.position);

  return { value: step.index, spelled: step.spelled };
}

/** The resource written out, and its key, written out or read from `each`. */
function targetOf(value: AttributeValue): { to: Address; key?: ImportKey } {
  const refuse = (): never => {
    throw new ConfigError(`import "to" ${TARGET}`, value.position);
  };
  if (value.type !== 'Reference') return refuse();

  const last = value.value.at(-1)!;
  const read = 'index' in last ? last : undefined;
  const address = Address.parse(spellReference(read ? value.value.slice(0, -1) : value.value), refuse);
  if (!address.module.isRoot() || (read && address.key !== undefined)) return refuse();

  return read ? { to: address, key: keyOf(read) } : { to: address };
}

export function decodeImport(block: Block): ImportBlock {
  const { to, id, for_each: forEach } = attributesIn(block.body);
  if (to === undefined || id === undefined) throw new ConfigError(`import needs ${to ? 'an "id"' : 'a "to"'}`, block.position);

  const target = targetOf(to);
  if (target.key && !forEach) throw new ConfigError('import "to" reads its key from each, which only for_each gives', to.position);

  return { type: 'Import', ...target, id, ...(forEach && { forEach }), position: block.position };
}
