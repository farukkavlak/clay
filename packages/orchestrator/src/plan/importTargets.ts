import { Address, ExactNumber, InstanceKey, isUnknown, ModuleAddress } from '@clay/contracts';
import { AttributeValue, ImportBlock, ModuleBlock, ResourceBlock, spell } from '@clay/parser';

import { eachFrom } from '../instances/forEach';
import { NotKnownYet } from '../instances/NotKnownYet';
import { Instances } from '../instances/Instances';
import { Context, ImportItem, importKey } from '../keys';
import { withPlace } from '../place';
import { isSensitive } from '../values/sensitive';
import { described, nullSource, Value } from '../values/Value';

/** One address an import block takes an object to, and the item of its for_each it was read for. */
export interface ImportTarget {
  block: ImportBlock;
  address: Address;
  item?: ImportItem;
}

/** Reads a value of the block at plan; undefined where a check does not know it yet. */
export type ReadImport = <T>(value: AttributeValue, block: ImportBlock, context: Context, parse: (value: Value) => T) => T | undefined;

export const refuseImport = (block: ImportBlock, message: string) => withPlace(new Error(message), block.position, spell(block), ModuleAddress.root);

/** An import block, and what its `to` names: each module call on the way, counted from the root, then the resource. */
export interface ImportTo {
  block: ImportBlock;
  path: (ModuleBlock | ResourceBlock)[];
}

/** What a key of the block's instances is; a block with neither has one instance and no key. */
function keyKind(block: ModuleBlock | ResourceBlock): 'number' | 'string' | undefined {
  if (block.count) return 'number';

  return block.forEach ? 'string' : undefined;
}

function keyName(kind: 'number' | 'string' | undefined): string {
  if (kind === 'number') return 'count, so an instance is named by a number, as in [0]';

  return kind === 'string' ? 'for_each, so an instance is named by a string, as in ["a"]' : 'neither count nor for_each, so it takes no key';
}

const kindOf = (key: InstanceKey | undefined) => (key === undefined ? undefined : typeof key === 'number' ? 'number' : 'string');

/** Each key of `to` of the kind the instances of its part have; before the plan, a part whose key is read is left to it. */
export function checkKeys({ block, path }: ImportTo, to: Address, read: boolean, named: string): void {
  const keys = [...to.module.path.map(({ key }) => key), to.key];

  for (const [part, declared] of path.entries()) {
    if (!read && block.keys.some((key) => key.part === part)) continue;

    const kind = keyKind(declared);
    if (kindOf(keys[part]) !== kind) throw refuseImport(block, `import to ${named}, but ${spell(declared)} has ${keyName(kind)}`);
  }
}

/** How a message names the value: of the block, or of one item of its for_each. */
const subject = (name: string, item?: ImportItem) => (item ? `import "${name}" for each.key "${item.key}"` : `import "${name}"`);

/** A string known at plan, and not sensitive, since the plan shows it. A value not known yet has its type, so one no apply can make a string is refused first. */
export function idFrom(value: Value, item?: ImportItem): string {
  const id = subject('id', item);
  const { kind } = value.type;
  const notAString = () => new Error(`${id} is a string, not ${described(value)}${nullSource(value)}`);
  if (kind !== 'string' && kind !== 'dynamic') throw notAString();
  if (isSensitive(value)) throw new Error(`${id} is sensitive, and the plan shows it`);
  if (isUnknown(value.data)) throw new NotKnownYet(`${id} must be known when planning: it reads a value only an apply makes`);
  if (typeof value.data !== 'string') throw notAString();
  if (value.data === '') throw new Error(`${id} must not be empty`);

  return value.data;
}

/** A string, or a whole number from 0, known at plan and not sensitive, since it shows in an address. */
function keyFrom(value: Value, item: ImportItem): InstanceKey {
  const key = `import "to" key for each.key "${item.key}"`;
  const { kind } = value.type;
  const notAKey = () => new Error(`${key} is a string or a whole number, not ${described(value)}${nullSource(value)}`);
  if (kind !== 'string' && kind !== 'number' && kind !== 'dynamic') throw notAKey();
  if (isSensitive(value)) throw new Error(`${key} is sensitive, and it shows in an address`);
  if (isUnknown(value.data)) throw new NotKnownYet(`${key} must be known when planning: it reads a value only an apply makes`);
  if (typeof value.data === 'string') return value.data;
  if (!(value.data instanceof ExactNumber)) throw notAKey();

  const index = value.data.toSafeInteger(key);
  if (index < 0) throw new Error(`${key} is a string or a whole number from 0, not ${index}`);

  return index;
}

/** `to` with each key read for `item`, or undefined where one is not known yet. */
function addressFor(block: ImportBlock, item: ImportItem, read: ReadImport): Address | undefined {
  const keys = new Map<number, InstanceKey>();
  for (const { part, value } of block.keys) {
    const key = read(value, block, item, (read) => keyFrom(read, item));
    if (key === undefined) return undefined;
    keys.set(part, key);
  }

  const { module, resourceType, name, key } = block.to;
  const keyAt = (part: number, written: InstanceKey | undefined) => (keys.has(part) ? keys.get(part) : written);
  const at = module.path.reduce((caller, step, part) => caller.child(step.name, keyAt(part, step.key)), ModuleAddress.root);

  return new Address(at, resourceType, name, keyAt(module.path.length, key));
}

/** One for each item of the block's for_each, or the block's own `to` where it has none. */
function targetsOfBlock(block: ImportBlock, read: ReadImport, instances: Instances): ImportTarget[] {
  if (!block.forEach) return [{ block, address: block.to }];

  const items = read(block.forEach, block, ModuleAddress.root, eachFrom);
  if (items === undefined) return [];

  // Kept as a block's for_each is, so `each.value` reads it.
  const at = importKey(block.position);
  instances.setEach(at, items);
  return [...items.keys()].flatMap((key) => {
    const item = new ImportItem(at, key);
    const address = addressFor(block, item, read);
    return address === undefined ? [] : [{ block, address, item }];
  });
}

/** Every address the imports to one resource take an object to, each once; a key read from `each` is checked here. */
export function targetsOf(imports: ImportTo[], read: ReadImport, instances: Instances): ImportTarget[] {
  const targets = new Map<string, ImportTarget>();

  for (const to of imports)
    for (const target of targetsOfBlock(to.block, read, instances)) {
      const key = target.address.toString();
      if (to.block.keys.length > 0) checkKeys(to, target.address, true, key);
      if (targets.has(key)) throw refuseImport(target.block, `two imports go to ${key}, and one object goes to each address`);
      targets.set(key, target);
    }

  return [...targets.values()];
}
