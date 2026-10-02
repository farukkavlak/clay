import { isUnknown } from '@clay/contracts';

import { kindOf } from './resolvers/readPath';
import { SetValue } from './SetValue';

/** A list names its instances by its strings, and gives each its own string as its value. */
function eachOfList(items: unknown[]): Map<string, unknown> {
  const values = new Map<string, unknown>();

  for (const [index, item] of items.entries()) {
    if (isUnknown(item)) throw new Error(`for_each must be known when planning: item [${index}] reads a value only an apply makes, and a list names its instances by its items`);
    if (typeof item !== 'string') throw new Error(`for_each is a list of strings, but item [${index}] is a ${kindOf(item)}`);
    if (values.has(item)) throw new Error(`for_each holds ${JSON.stringify(item)} twice; each instance needs a key of its own`);

    values.set(item, item);
  }

  return values;
}

/** A set holds each member once and none unknown, so only one that is not a string is wrong; it has no index to name it by. */
function eachOfSet({ members }: SetValue): Map<string, unknown> {
  const other = members.findIndex((member) => typeof member !== 'string');
  if (other !== -1) throw new Error(`for_each is a set of strings, but it holds a ${kindOf(members[other])}`);

  return eachOfList([...members]);
}

/** A list, a set or a map, as the key and value of each instance. */
function entriesOf(value: unknown): [string, unknown][] {
  if (value instanceof SetValue) return [...eachOfSet(value)];
  if (Array.isArray(value)) return [...eachOfList(value)];

  return Object.entries(value as Record<string, unknown>);
}

/**
 * The instances a for_each makes, by key, with the value each is given.
 * Sorted by key, since an object puts a key like "1" first whatever order it was written in.
 * A map's keys are known before its values, so an instance can be made while its value is still unknown.
 */
export function eachFrom(value: unknown): Map<string, unknown> {
  if (isUnknown(value)) throw new Error('for_each must be known when planning: it reads a value only an apply makes');

  const kind = kindOf(value);
  if (kind !== 'list' && kind !== 'set' && kind !== 'map') throw new Error(`for_each is a map, or a list or a set of strings, not a ${kind}`);

  return new Map(entriesOf(value).sort(([a], [b]) => (a < b ? -1 : 1)));
}
