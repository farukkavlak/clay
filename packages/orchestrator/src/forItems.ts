import { AttributePath, EVERY_ITEM, ExactNumber, isMarker, isMaybe, isUnknown, SENSITIVE, sensitiveUnder, Type, typeAt, types, UNKNOWN } from '@clay/contracts';
import { ConfigError, Position } from '@clay/parser';

import { UnresolvedReferenceError } from './resolvers/UnresolvedReferenceError';
import {
  child,
  described,
  everyItemMarks,
  fewest,
  hasText,
  isSensitive,
  marksOfWhole,
  mayBeSensitive,
  nullSource,
  objectOf,
  sharedMarks,
  tupleOf,
  Value,
  valueOf,
  wholeWhere,
  Whole,
  withSensitive,
} from './Value';

export type ForItem = [key: Value, value: Value];

const TAKEN = new Set(['list', 'tuple', 'set', 'map', 'object']);

const indexOf = (index: number) => valueOf(types.number, ExactNumber.parse(String(index)));

/** An unknown collection is checked by its type, unless that is unknown too. */
export function checkCollection(collection: Value, position: Position): void {
  const { kind } = collection.type;
  // `dynamic` means unknown or null.
  if (collection.data === null || !(TAKEN.has(kind) || kind === 'dynamic'))
    throw new ConfigError(`A for goes over a list, a tuple, a set, a map or an object, not ${described(collection)}${nullSource(collection)}`, position);
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

/** The attributes of an object type in key order, an optional one too since a value is filled to its type, and the places of a tuple type. */
function typeSteps(type: Type): (string | number)[] {
  if (type.kind === 'object') return Object.keys(type.attributes).sort();

  return type.kind === 'tuple' ? type.elements.map((_, index) => index) : [];
}

function markedSteps(collection: Value): (string | number)[] {
  return (collection.sensitive ?? []).flatMap((path) => (path[0] === undefined || isMarker(path[0]) || isMaybe(path) ? [] : [path[0]]));
}

/**
 * The steps a collection not known yet holds for certain that come first, in the order a for goes over them:
 * every one of an object or tuple type, which holds no other, or else every place up to the last that a mark names.
 */
function leadingSteps(collection: Value): (string | number)[] {
  const { kind } = collection.type;
  if (kind === 'object' || kind === 'tuple') return typeSteps(collection.type);

  const places = markedSteps(collection).filter((step): step is number => typeof step === 'number');
  return places.length === 0 ? [] : Array.from({ length: Math.max(...places) + 1 }, (_, index) => index);
}

/** The keys and places every value a collection not known yet may be holds: those its type names and those it marks, the `leading` ones first. */
export function certainSteps(collection: Value): { steps: (string | number)[]; leading: number } {
  const leading = leadingSteps(collection);

  return { steps: [...new Map([...leading, ...markedSteps(collection)].map((step) => [String(step), step])).values()], leading: leading.length };
}

/** An item of a collection not known yet at a step it holds for certain: its key or index is known, its value is not. */
export function certainItem(collection: Value, step: string | number): ForItem {
  const key = typeof step === 'number' ? valueOf(types.number, ExactNumber.parse(String(step))) : valueOf(types.string, step);

  return [key, withSensitive(valueOf(typeAt(collection.type, step), UNKNOWN), sensitiveUnder(collection.sensitive ?? [], step))];
}

/** A key must be text, so a key of another type is refused even while unknown. */
export function checkKey(key: Value, position: Position): void {
  if (key.data === null || !(hasText(key.type) || key.type.kind === 'dynamic'))
    throw new ConfigError(`A key in a for is a string, a number or a boolean, not ${described(key)}${nullSource(key)}`, position);
  // As in a map: setting it as a property would set a prototype.
  if (key.data === '__proto__') throw new ConfigError('__proto__ cannot be a name', position);
}

/** Hidden where any item that gives the key is sensitive, since the message would say what the sensitive one is. */
function shownKey(text: string, keys: Value[]): string {
  const sensitive = keys.some((key) => isSensitive(key) && !isUnknown(key.data) && String(key.data) === text);

  return sensitive ? SENSITIVE : `"${text}"`;
}

/** Two items that give one known key, where the for does not group them. */
export function refuseDuplicateKeys(keys: Value[], position: Position): void {
  const seen = new Set<string>();
  for (const key of keys) {
    if (isUnknown(key.data)) continue;

    const text = String(key.data);
    if (seen.has(text)) throw new ConfigError(`Two items give the key ${shownKey(text, keys)}; write "..." after the value to group them`, position);
    seen.add(text);
  }
}

export const under = (step: string | number, marks: readonly AttributePath[]) => marks.map((path) => [step, ...path]);

/** The marks of the items a group holds for certain before any item that may join it, at their places in the group. */
function groupPlaces(entries: ForItem[], kept: boolean[], text: string): AttributePath[] {
  const marks: AttributePath[] = [];
  let place = 0;
  for (const [index, [key, value]] of entries.entries()) {
    if (!isUnknown(key.data) && String(key.data) !== text) continue;
    if (isUnknown(key.data) || !kept[index]) break;
    marks.push(...under(place++, value.sensitive ?? []));
  }
  return marks;
}

/**
 * The marks of what a for gives as an object before its keys, or which items it keeps, are known: each key has the marks every value has.
 * A known key of an item kept for certain has that value's marks, or, grouped, the marks every value that may join it has,
 * and those of the items it holds for certain first at their places. `entries` come in the order the for goes over them.
 */
export function laterObjectMarks(entries: ForItem[], kept: boolean[], grouped: boolean): AttributePath[] {
  const values = entries.map(([, value]) => value);
  const known = entries.flatMap(([key, value], index): [string, Value][] => (kept[index] && !isUnknown(key.data) ? [[String(key.data), value]] : []));

  const marks = known.flatMap(([text, value]) => {
    if (!grouped) return under(text, value.sensitive ?? []);

    const joining = entries.filter(([key]) => isUnknown(key.data) || String(key.data) === text).map(([, joined]) => joined);
    return under(text, [...under(EVERY_ITEM, sharedMarks(joining)), ...groupPlaces(entries, kept, text)]);
  });
  return fewest([...(grouped ? under(EVERY_ITEM, everyItemMarks(values)) : everyItemMarks(values)), ...marks]);
}

/** As for an object; an item kept for certain before any the if may drop has its own place. `bodies` come in the order the for goes over them. */
export function laterTupleMarks(bodies: Value[], kept: boolean[]): AttributePath[] {
  let leading = 0;
  while (kept[leading]) leading++;

  return fewest([...everyItemMarks(bodies), ...bodies.slice(0, leading).flatMap((body, index) => under(index, body.sensitive ?? []))]);
}

/**
 * With `grouped`, each key holds its values in a tuple; without it, a duplicate key is refused.
 * Every known key is checked before an unknown key makes the whole result unknown.
 * A sensitive key makes the whole object sensitive, since its names are its shape. `whole` says whether the collection is, as a whole, or may be.
 */
export function forObject(entries: ForItem[], grouped: boolean, whole: Whole, position: Position): Value {
  for (const [key] of entries) checkKey(key, position);
  if (!grouped)
    refuseDuplicateKeys(
      entries.map(([key]) => key),
      position
    );

  // One unknown key makes the object's shape unknown; every item is there, so a sensitive key makes the whole sensitive.
  const keyed = { sensitive: whole.sensitive || entries.some(([key]) => isSensitive(key)), maybe: whole.maybe || entries.some(([key]) => mayBeSensitive(key)) };
  if (entries.some(([key]) => isUnknown(key.data))) {
    const marks = keyed.sensitive
      ? [[]]
      : laterObjectMarks(
          entries,
          entries.map(() => true),
          grouped
        );
    throw new UnresolvedReferenceError('A key in a for is known only after apply, so what the for gives is not known yet', types.dynamic, marksOfWhole(keyed, marks));
  }

  const keys = new Map<string, Value[]>();
  for (const [key, value] of entries) {
    const text = String(key.data);
    keys.set(text, [...(keys.get(text) ?? []), value]);
  }

  const made = objectOf([...keys].map(([key, values]) => [key, grouped ? tupleOf(values) : values[0]]));
  return wholeWhere(made, keyed.sensitive, keyed.maybe);
}
