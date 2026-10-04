import { isUnknown } from '@clay/contracts';

import { child, described, Value } from './Value';

/** How a message names an item: a list's or a tuple's by its index, a set's by none, since its members have none. */
const LIST = { kind: 'list', item: (index: number) => `item [${index}]`, holds: (index: number) => `item [${index}] is`, items: 'items' };
const SET = { kind: 'set', item: () => 'a member', holds: () => 'it holds', items: 'members' };

/** A list, a tuple or a set names its instances by its strings, and gives each its own string as its value. */
function eachOfItems(value: Value): Map<string, Value> {
  const values = new Map<string, Value>();
  const words = value.type.kind === 'set' ? SET : LIST;

  for (const [index, data] of (value.data as unknown[]).entries()) {
    if (isUnknown(data))
      throw new Error(
        `for_each must be known when planning: ${words.item(index)} reads a value only an apply makes, and a ${words.kind} names its instances by its ${words.items}`
      );
    if (typeof data !== 'string') throw new Error(`for_each is a ${words.kind} of strings, but ${words.holds(index)} ${described(child(value, index))}`);
    if (values.has(data)) throw new Error(`for_each holds ${JSON.stringify(data)} twice; each instance needs a key of its own`);

    values.set(data, child(value, index));
  }

  return values;
}

/** A map or an object, as the key and value of each instance; a list, a tuple or a set of strings, as its strings. */
function entriesOf(value: Value): [string, Value][] {
  if (value.type.kind === 'map' || value.type.kind === 'object') return Object.keys(value.data as Record<string, unknown>).map((key) => [key, child(value, key)]);

  return [...eachOfItems(value)];
}

const TAKEN = new Set(['map', 'object', 'list', 'tuple', 'set']);

/**
 * The instances a for_each makes, by key, with the value each is given.
 * Sorted by key, since an object puts a key like "1" first whatever order it was written in.
 * A map's keys are known before its values, so an instance can be made while its value is still unknown.
 */
export function eachFrom(value: Value): Map<string, Value> {
  if (isUnknown(value.data)) throw new Error('for_each must be known when planning: it reads a value only an apply makes');
  if (value.data === null || !TAKEN.has(value.type.kind)) throw new Error(`for_each is a map, or a list or a set of strings, not ${described(value)}`);

  return new Map(entriesOf(value).sort(([a], [b]) => (a < b ? -1 : 1)));
}
