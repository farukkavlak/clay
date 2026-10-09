import { ExactNumber, isUnknown, Type, types, UNKNOWN } from '@clay/contracts';
import { ConfigError, Position } from '@clay/parser';

import { UnresolvedReferenceError } from './resolvers/UnresolvedReferenceError';
import { allSensitiveIf, child, described, hasText, HIDDEN, isSensitive, objectOf, tupleOf, Value, valueOf, wholeIf } from './Value';

export type ForItem = [key: Value, value: Value];

const TAKEN = new Set(['list', 'tuple', 'set', 'map', 'object']);

const indexOf = (index: number) => valueOf(types.number, ExactNumber.parse(String(index)));

/** An unknown collection is checked by its type, unless that is unknown too. */
export function checkCollection(collection: Value, position: Position): void {
  const { kind } = collection.type;
  // `dynamic` means unknown or null.
  if (collection.data === null || !(TAKEN.has(kind) || kind === 'dynamic'))
    throw new ConfigError(`A for goes over a list, a tuple, a set, a map or an object, not ${described(collection)}`, position);
}

/** A set's members are their own keys; a map's or object's values come in key order. */
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

function keyType(type: Type): Type {
  if (type.kind === 'list' || type.kind === 'tuple') return types.number;
  if (type.kind === 'map' || type.kind === 'object') return types.string;

  return type.kind === 'set' ? type.element : types.dynamic;
}

/** Typed where every item shares a type, `dynamic` otherwise. */
export function unknownItem(type: Type): ForItem {
  const value = type.kind === 'list' || type.kind === 'set' || type.kind === 'map' ? type.element : types.dynamic;

  return [valueOf(keyType(type), UNKNOWN), valueOf(value, UNKNOWN)];
}

/** A key must be text, so a key of another type is refused even while unknown. */
export function checkKey(key: Value, position: Position): void {
  if (key.data === null || !(hasText(key.type) || key.type.kind === 'dynamic'))
    throw new ConfigError(`A key in a for is a string, a number or a boolean, not ${described(key)}`, position);
  // As in a map: setting it as a property would set a prototype.
  if (key.data === '__proto__') throw new ConfigError('__proto__ cannot be a name', position);
}

/** Hidden where any item that gives the key is sensitive, since the message would say what the sensitive one is. */
function shownKey(text: string, entries: ForItem[]): string {
  const sensitive = entries.some(([key]) => isSensitive(key) && !isUnknown(key.data) && String(key.data) === text);

  return sensitive ? HIDDEN : `"${text}"`;
}

/**
 * With `grouped`, each key holds its values in a tuple; without it, a duplicate key is refused.
 * Every known key is checked before an unknown key makes the whole result unknown.
 * A sensitive key makes the whole object sensitive, since its names are its shape. `sensitive` says the collection is, as a whole.
 */
export function forObject(entries: ForItem[], grouped: boolean, sensitive: boolean, position: Position): Value {
  const keys = new Map<string, Value[]>();
  for (const [key, value] of entries) {
    checkKey(key, position);
    if (isUnknown(key.data)) continue;

    const text = String(key.data);
    const values = keys.get(text) ?? [];
    if (values.length > 0 && !grouped) throw new ConfigError(`Two items give the key ${shownKey(text, entries)}; write "..." after the value to group them`, position);
    keys.set(text, [...values, value]);
  }

  // One unknown key makes the object's shape unknown.
  if (entries.some(([key]) => isUnknown(key.data)))
    throw new UnresolvedReferenceError(
      'A key in a for is known only after apply, so what the for gives is not known yet',
      types.dynamic,
      wholeIf(sensitive || entries.flat().some((part) => isSensitive(part)))
    );

  return allSensitiveIf(
    entries.some(([key]) => isSensitive(key)),
    objectOf([...keys].map(([key, values]) => [key, grouped ? tupleOf(values) : values[0]]))
  );
}
