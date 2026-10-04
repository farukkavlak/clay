import { ExactNumber, types } from '@clay/contracts';
import { ConfigError, Position } from '@clay/parser';

import { child, described, Value, valueOf } from './Value';

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
