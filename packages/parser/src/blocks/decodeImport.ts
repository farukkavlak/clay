import { Address } from '@clay/contracts';

import { AttributeValue, ImportBlock } from '../ast';
import { Attribute, Block } from '../body';
import { ConfigError } from '../ConfigError';
import { spellReference } from '../reference';
import { attributesIn } from './attributes';

const TARGET = 'is a resource of the root module or an instance of one, as in local_file.a or local_file.a[0]';

/** Checked as it is read. */
export function checkImportArgument({ name, value }: Attribute): void {
  if (name !== 'to' && name !== 'id') throw new ConfigError(`import takes only "to" and "id", not "${name}".`, value.position);
}

/** Written out, since the import is planned before any value is known. */
function targetOf(value: AttributeValue): Address {
  const refuse = (): never => {
    throw new ConfigError(`import "to" ${TARGET}`, value.position);
  };
  if (value.type !== 'Reference') return refuse();

  const address = Address.parse(spellReference(value.value), refuse);
  return address.module.isRoot() ? address : refuse();
}

export function decodeImport(block: Block): ImportBlock {
  const { to, id } = attributesIn(block.body);
  if (to === undefined || id === undefined) throw new ConfigError(`import needs ${to ? 'an "id"' : 'a "to"'}`, block.position);

  return { type: 'Import', to: targetOf(to), id, position: block.position };
}
