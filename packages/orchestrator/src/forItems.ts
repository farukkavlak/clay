import { ExactNumber, isUnknown, Type, types, UNKNOWN } from '@clay/contracts';
import { ConfigError, Position } from '@clay/parser';

import { UnresolvedReferenceError } from './resolvers/UnresolvedReferenceError';
import { child, described, hasText, objectOf, tupleOf, Value, valueOf } from './Value';

/** What a for gives one item: its key and its value. */
export type ForItem = [key: Value, value: Value];

const TAKEN = new Set(['list', 'tuple', 'set', 'map', 'object']);

const indexOf = (index: number) => valueOf(types.number, ExactNumber.parse(String(index)));

/** A collection a for cannot go over is refused at `position`, where it is written; one not known yet by the type it will have, unless that is not known either. */
export function checkCollection(collection: Value, position: Position): void {
  const { kind } = collection.type;
  // A value of no type is one not known yet, or null.
  if (collection.data === null || !(TAKEN.has(kind) || kind === 'dynamic'))
    throw new ConfigError(`A for goes over a list, a tuple, a set, a map or an object, not ${described(collection)}`, position);
}

/** A list's or a tuple's items by their index, a set's members as their own keys, and a map's or an object's values by their keys, in the order of the keys. */
export function forItems(collection: Value, position: Position): ForItem[] {
  checkCollection(collection, position);
  const { kind } = collection.type;

  if (kind === 'map' || kind === 'object')
    return Object.keys(collection.data as Record<string, unknown>)
      .sort()
      .map((key) => [valueOf(types.string, key), child(collection, key)]);

  const items = (collection.data as unknown[]).map((_, index) => child(collection, index));
  return items.map((item, index) => [kind === 'set' ? item : indexOf(index), item]);
}

/** The key a for gives an item of a collection of `type`: a list's or a tuple's index, a map's or an object's key, and a set's member, which is its own key. */
function keyType(type: Type): Type {
  if (type.kind === 'list' || type.kind === 'tuple') return types.number;
  if (type.kind === 'map' || type.kind === 'object') return types.string;

  return type.kind === 'set' ? type.element : types.dynamic;
}

/** An item of a collection of `type` not known yet, its key and value of the types they will have where every item shares them. */
export function unknownItem(type: Type): ForItem {
  const value = type.kind === 'list' || type.kind === 'set' || type.kind === 'map' ? type.element : types.dynamic;

  return [valueOf(keyType(type), UNKNOWN), valueOf(value, UNKNOWN)];
}

/** A key is text, so one of a type no key can have is refused at `position` even before it is known. */
function checkKey(key: Value, position: Position): void {
  if (key.data === null || !(hasText(key.type) || key.type.kind === 'dynamic'))
    throw new ConfigError(`A key in a for is a string, a number or a boolean, not ${described(key)}`, position);
  // Refused as in a map, where code that sets it as a property would set a prototype.
  if (key.data === '__proto__') throw new ConfigError('__proto__ cannot be a name', position);
}

/**
 * The object a for makes from each item's key and value; with `grouped`, each key holds the values of its items in a tuple, and without it a key given
 * twice is refused at `position`. Every key that can be checked is, before one not known yet leaves the whole for to the apply.
 */
export function forObject(entries: ForItem[], grouped: boolean, position: Position): Value {
  const keys = new Map<string, Value[]>();
  for (const [key, value] of entries) {
    checkKey(key, position);
    if (isUnknown(key.data)) continue;

    const text = String(key.data);
    const values = keys.get(text) ?? [];
    if (values.length > 0 && !grouped) throw new ConfigError(`Two items give the key "${text}"; write "..." after the value to group them`, position);
    keys.set(text, [...values, value]);
  }

  // How many keys there are, and so what the object holds, waits on the one not known yet.
  if (entries.some(([key]) => isUnknown(key.data))) throw new UnresolvedReferenceError('A key in a for is known only after apply, so what the for gives is not known yet');
  return objectOf([...keys].map(([key, values]) => [key, grouped ? tupleOf(values) : values[0]]));
}
