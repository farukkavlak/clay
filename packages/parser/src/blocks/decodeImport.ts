import { Address } from '@clay/contracts';

import { AttributeValue, ImportBlock, ImportKey, namedIn, Step } from '../ast';
import { Attribute, Block } from '../body';
import { ConfigError } from '../ConfigError';
import { parseReference, spellReference } from '../reference';
import { attributesIn } from './attributes';

const TARGET = 'is a resource or an instance of one, as in local_file.a, local_file.a[0] or module.m["x"].local_file.a';
const ARGUMENTS = new Set(['to', 'id', 'for_each']);

/** Checked as it is read. */
export function checkImportArgument({ name, value }: Attribute): void {
  if (!ARGUMENTS.has(name)) throw new ConfigError(`import takes only "to", "id" and "for_each", not "${name}".`, value.position);
}

/** A key read from a value reads only `each`, so the resource is known before any value is. */
function keyOf(step: { index: AttributeValue; spelled: string }, part: number): ImportKey {
  for (const named of namedIn(step.index))
    if (named.type === 'Reference' && parseReference(named.value, named.position).kind !== 'each')
      throw new ConfigError('import "to" reads only each in its key, as in local_file.a[each.key]', named.position);

  return { part, value: step.index, spelled: step.spelled };
}

/** The part of `to` a key at `at` follows, each two names: a module call, counted from the root, or the resource past the last. */
function partAt(steps: Step[], at: number): number | undefined {
  if (!('name' in steps[at - 1])) return undefined;

  const names = steps.slice(0, at).filter((step) => 'name' in step).length;
  return names % 2 === 0 ? names / 2 - 1 : undefined;
}

/** The resource written out with the keys written out, and each key read from `each`. */
function targetOf(value: AttributeValue): { to: Address; keys: ImportKey[] } {
  const refuse = (): never => {
    throw new ConfigError(`import "to" ${TARGET}`, value.position);
  };
  if (value.type !== 'Reference') return refuse();

  const steps = value.value;
  const to = Address.parse(spellReference(steps.filter((step) => !('index' in step))), refuse);
  const keys = steps.flatMap((step, at) => ('index' in step ? [keyOf(step, partAt(steps, at) ?? refuse())] : []));

  return { to, keys };
}

export function decodeImport(block: Block): ImportBlock {
  const { to, id, for_each: forEach } = attributesIn(block.body);
  if (to === undefined || id === undefined) throw new ConfigError(`import needs ${to ? 'an "id"' : 'a "to"'}`, block.position);

  const target = targetOf(to);
  if (target.keys.length > 0 && !forEach) throw new ConfigError('import "to" reads its key from each, which only for_each gives', to.position);

  return { type: 'Import', ...target, id, ...(forEach && { forEach }), position: block.position };
}
