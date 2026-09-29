import { containsUnknown } from '@clay/planner';

import { kindOf } from './resolvers/readPath';

/** A list names its instances by its strings, and gives each its own string as its value. */
function eachOfList(items: unknown[]): Map<string, unknown> {
  const values = new Map<string, unknown>();

  for (const [index, item] of items.entries()) {
    if (typeof item !== 'string') throw new Error(`for_each is a list of strings, but item [${index}] is a ${kindOf(item)}`);
    if (values.has(item)) throw new Error(`for_each holds ${JSON.stringify(item)} twice; each instance needs a key of its own`);

    values.set(item, item);
  }

  return values;
}

/**
 * The instances a for_each makes, by key, with the value each is given.
 * Sorted by key, since an object puts a key like "1" first whatever order it was written in.
 */
export function eachFrom(value: unknown): Map<string, unknown> {
  if (containsUnknown(value)) throw new Error('for_each must be known when planning: it reads a value only an apply makes');

  const kind = kindOf(value);
  if (kind !== 'list' && kind !== 'map') throw new Error(`for_each is a map or a list of strings, not a ${kind}`);

  const entries = kind === 'list' ? [...eachOfList(value as unknown[])] : Object.entries(value as Record<string, unknown>);
  return new Map(entries.sort(([a], [b]) => (a < b ? -1 : 1)));
}
