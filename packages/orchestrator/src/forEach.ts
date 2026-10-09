import { isUnknown } from '@clay/contracts';

import { NotKnownYet } from './NotKnownYet';
import { child, described, isAllSensitive, isSensitive, Value } from './Value';

/** For messages: a set's members have no index. */
const LIST = { kind: 'list', item: (index: number) => `item [${index}]`, holds: (index: number) => `item [${index}] is`, items: 'items' };
const SET = { kind: 'set', item: () => 'a member', holds: () => 'it holds', items: 'members' };

/** Each string is both the key and the value. */
function eachOfItems(value: Value): Map<string, Value> {
  const values = new Map<string, Value>();
  const words = value.type.kind === 'set' ? SET : LIST;

  for (const [index, data] of (value.data as unknown[]).entries()) {
    if (isUnknown(data))
      throw new NotKnownYet(
        `for_each must be known when planning: ${words.item(index)} reads a value only an apply makes, and a ${words.kind} names its instances by its ${words.items}`
      );
    if (typeof data !== 'string') throw new Error(`for_each is a ${words.kind} of strings, but ${words.holds(index)} ${described(child(value, index))}`);
    if (values.has(data)) throw new Error(`for_each holds ${JSON.stringify(data)} twice; each instance needs a key of its own`);

    values.set(data, child(value, index));
  }

  return values;
}

function entriesOf(value: Value): [string, Value][] {
  if (value.type.kind === 'map' || value.type.kind === 'object') return Object.keys(value.data as Record<string, unknown>).map((key) => [key, child(value, key)]);

  return [...eachOfItems(value)];
}

const TAKEN = new Set(['map', 'object', 'list', 'tuple', 'set']);

function notTaken(value: Value): Error {
  return new Error(`for_each is a map, or a list or a set of strings, not ${described(value)}`);
}

/** A map's keys are sensitive only where the whole map is; a list's or a set's items are its keys. */
function keysSensitive(value: Value): boolean {
  const { kind } = value.type;

  return kind === 'list' || kind === 'tuple' || kind === 'set' ? isSensitive(value) : isAllSensitive(value);
}

/**
 * Sorted by key, since an object puts a key like "1" first whatever order it was written in.
 * A map's keys are known before its values, so an instance can exist while its value is still unknown.
 * A value not known yet has its type, so one no apply can make a collection is refused first.
 * So is one with a sensitive key, known or not.
 */
export function eachFrom(value: Value): Map<string, Value> {
  const taken = TAKEN.has(value.type.kind);
  if (!taken && value.type.kind !== 'dynamic') throw notTaken(value);
  if (keysSensitive(value)) throw new Error('for_each is sensitive: a key shows in an address, so it cannot be hidden');
  if (isUnknown(value.data)) throw new NotKnownYet('for_each must be known when planning: it reads a value only an apply makes');
  if (value.data === null || !taken) throw notTaken(value);

  return new Map(entriesOf(value).sort(([a], [b]) => (a < b ? -1 : 1)));
}
