import { AttributePath, EVERY_ITEM, EXACT, ExactNumber, holdsFirst, isMarker, isUnknown, SENSITIVE, sensitiveUnder, Type, typeAt, types, UNKNOWN } from '@clay/contracts';
import { ConfigError, ForNode, Position } from '@clay/parser';

import { UnresolvedReferenceError } from './resolvers/UnresolvedReferenceError';
import {
  child,
  described,
  everyItemMarks,
  fewest,
  hasText,
  isSensitive,
  marksOfWhole,
  maybeMarks,
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

const SPLATTED = new Set(['list', 'tuple', 'set']);

/** How a message names what goes over the collection: `a for`, or `[*]` where that is how it was written. */
export function goer(node: ForNode): string {
  return node.splat ? '[*]' : 'a for';
}

const indexOf = (index: number) => valueOf(types.number, ExactNumber.parse(String(index)));

/** An unknown collection is checked by its type, unless that is unknown too. `[*]` takes no map or object. */
export function checkCollection(collection: Value, node: ForNode): void {
  const { kind } = collection.type;
  const [taken, takes] = node.splat ? [SPLATTED, '[*] goes over a list, a tuple or a set'] : [TAKEN, 'A for goes over a list, a tuple, a set, a map or an object'];
  // `dynamic` means unknown or null.
  if (collection.data === null || !(taken.has(kind) || kind === 'dynamic'))
    throw new ConfigError(`${takes}, not ${described(collection)}${nullSource(collection)}`, node.collection.position);
}

/** A set's members are their own keys; a map's or object's values come in key order. */
export function forItems(collection: Value, node: ForNode): ForItem[] {
  checkCollection(collection, node);
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

/** An object type names each of its attributes and a tuple type each of its places, so it holds no item the plan cannot name. */
export const namesEveryItem = (type: Type) => type.kind === 'object' || type.kind === 'tuple';

/** The attributes of an object type in key order, an optional one too since a value is filled to its type, and the places of a tuple type. */
function typeSteps(type: Type): (string | number)[] {
  if (type.kind === 'object') return Object.keys(type.attributes).sort();

  return type.kind === 'tuple' ? type.elements.map((_, index) => index) : [];
}

/** Whether a mark names a key or a place of the collection, which an item at any other one does not have. */
export function namesAStep(collection: Value): boolean {
  return (collection.sensitive ?? []).some(([first]) => first !== undefined && !isMarker(first));
}

/** The keys and places only a mark that the part may be sensitive names, so the collection may hold them; none of `certain`. */
export function maybeSteps(collection: Value, certain: (string | number)[]): (string | number)[] {
  const held = new Set(certain.map(String));
  const named = (collection.sensitive ?? []).flatMap(([first]) => (first === undefined || isMarker(first) || held.has(String(first)) ? [] : [first]));

  return [...new Map(named.map((step) => [String(step), step])).values()];
}

function markedSteps(collection: Value): (string | number)[] {
  return (collection.sensitive ?? []).flatMap((path) => (holdsFirst(path) ? [path[0]] : []));
}

/**
 * The steps a collection not known yet holds for certain that come first, in the order a for goes over them:
 * every one of an object or tuple type, which holds no other, or else every place up to the last that a mark names.
 */
function leadingSteps(collection: Value): (string | number)[] {
  if (namesEveryItem(collection.type)) return typeSteps(collection.type);

  const places = markedSteps(collection).filter((step): step is number => typeof step === 'number');
  return places.length === 0 ? [] : Array.from({ length: Math.max(...places) + 1 }, (_, index) => index);
}

/** The keys and places every value a collection not known yet may be holds: those its type names and those it marks, the `leading` ones first. */
export function certainSteps(collection: Value): { steps: (string | number)[]; leading: number } {
  const leading = leadingSteps(collection);

  return { steps: [...new Map([...leading, ...markedSteps(collection)].map((step) => [String(step), step])).values()], leading: leading.length };
}

/** An item of a collection not known yet at a step it holds, or may hold: its key or index is known, its value is not. */
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

const givesKey = ([key]: ForItem, text: string) => !isUnknown(key.data) && String(key.data) === text;

/** How many items come first that the if keeps for certain. */
function leadingKept(kept: boolean[]): number {
  let leading = 0;
  while (kept[leading]) leading++;

  return leading;
}

/**
 * As for an object; an item kept for certain before any the if may drop has its own place, which no other item may take, and so has one `placed`.
 * `bodies` come in the order the for goes over them.
 */
export function laterTupleMarks(bodies: Value[], kept: boolean[], placed: boolean[]): AttributePath[] {
  const leading = leadingKept(kept);
  const unnamed = bodies.filter((_, index) => index >= leading && placed[index] !== true);

  const places = bodies.slice(0, leading).flatMap((body, index) => under(index, [...(body.sensitive ?? []), [EXACT]]));
  return fewest([...everyItemMarks(bodies, unnamed), ...places]);
}

/**
 * As for a tuple, where an item lands at its own place or before it: a place after those kept for certain may hold only an item from there on,
 * so it has what those may have. Only the first `inOrder` of `bodies` come in the order the for goes over them, and all of them by default.
 * Each of those has a place with its own marks, so it gives none under every item.
 */
export function pickedTupleMarks(bodies: Value[], kept: boolean[], inOrder = bodies.length): AttributePath[] {
  const leading = leadingKept(kept);
  const after = bodies.slice(leading, Math.max(leading, inOrder)).flatMap((_, offset) => under(leading + offset, maybeMarks(bodies.slice(leading + offset))));

  return fewest([
    ...laterTupleMarks(
      bodies,
      kept,
      bodies.map((_, index) => index < inOrder)
    ),
    ...after,
  ]);
}

/**
 * The one item kept for certain that gives the key, which no other may give; else any item that gives it, which may be dropped,
 * or one whose key is not known yet.
 */
function forKeyMarks(entries: ForItem[], kept: boolean[], text: string): AttributePath[] {
  const giving = entries.flatMap((entry, index) => (givesKey(entry, text) ? [{ value: entry[1], kept: kept[index] }] : []));
  const sure = giving.filter((item) => item.kept).map((item) => item.value);
  const later = entries.filter(([key]) => isUnknown(key.data)).map(([, value]) => value);

  return sure.length > 0
    ? sharedMarks(sure)
    : maybeMarks(
        giving.map((item) => item.value),
        later
      );
}

/** The marks of a group as of a tuple of the values that may join it, the first `inOrder` of `entries` in its order; with no item sure to join, it may not be there. */
function groupMarks(entries: ForItem[], kept: boolean[], text: string, inOrder: number): AttributePath[] {
  const joining = entries.flatMap((entry, index) =>
    isUnknown(entry[0].data) || givesKey(entry, text) ? [{ value: entry[1], sure: kept[index] && givesKey(entry, text), ordered: index < inOrder }] : []
  );
  const values = joining.map(({ value }) => value);
  if (!joining.some(({ sure }) => sure)) return under(EVERY_ITEM, maybeMarks(values));

  const ordered = joining.findIndex((join) => !join.ordered);
  return pickedTupleMarks(
    values,
    joining.map(({ sure }) => sure),
    ordered === -1 ? joining.length : ordered
  );
}

/**
 * The marks of what a for gives as an object before its keys, or which items it keeps, are known: each key has the marks every value has,
 * and those an item with a key not known yet may have. A known key has the marks of the items that give it, or, grouped, of the group.
 * Only the first `inOrder` of `entries` come in the order the for goes over them, and all of them by default.
 */
export function laterObjectMarks(entries: ForItem[], kept: boolean[], grouped: boolean, inOrder = entries.length): AttributePath[] {
  const values = entries.map(([, value]) => value);
  const every = everyItemMarks(
    values,
    entries.filter(([key]) => isUnknown(key.data)).map(([, value]) => value)
  );
  const texts = new Set(entries.flatMap(([key]) => (isUnknown(key.data) ? [] : [String(key.data)])));
  // With an item kept for certain that gives it, the key is there; an item with a key not known yet may only join its group, or fail as a duplicate.
  const exact = (text: string) => (entries.some((entry, index) => kept[index] && givesKey(entry, text)) ? [[EXACT]] : []);
  const marks = [...texts].flatMap((text) => under(text, [...(grouped ? groupMarks(entries, kept, text, inOrder) : forKeyMarks(entries, kept, text)), ...exact(text)]));

  return fewest([...(grouped ? under(EVERY_ITEM, every) : every), ...marks]);
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
