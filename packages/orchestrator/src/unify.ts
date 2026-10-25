import { AttributePath, isRecord, isUnknown, own, Type, typeAt, types, UNKNOWN } from '@clay/contracts';
import { spellSteps, Step } from '@clay/parser';

import { converted } from './conformValues';
import { article, child, objectOf, tupleOf, Value, valueOf, withSensitive } from './Value';

export class Unjoinable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Unjoinable';
  }
}

const FAMILIES: Record<Type['kind'], string> = {
  string: 'primitive',
  number: 'primitive',
  bool: 'primitive',
  dynamic: 'dynamic',
  list: 'sequence',
  set: 'sequence',
  tuple: 'sequence',
  map: 'mapping',
  object: 'mapping',
};

export function isSequence(kind: Type['kind']): boolean {
  return FAMILIES[kind] === 'sequence';
}

/** The reason names attributes of the types, which are keys of the value, so it is left out where a part of the value is sensitive. */
export function unjoined(error: Unjoinable, sensitive: boolean): string {
  return sensitive ? 'cannot join what it holds into one type; a part of it is sensitive, so no more is shown' : error.message;
}

function unjoinable(reason: string, at: Step[]): Unjoinable {
  return new Unjoinable(`cannot join ${reason} into one type${at.length > 0 ? `, at ${spellSteps(at)} in each item` : ''}`);
}

/** A string can hold numbers and bools as text; a number with a bool and no string is most often a mistake, so it is refused unless `loose`. */
function primitive(found: readonly Type[], at: Step[], loose: boolean): Type {
  const kinds = new Set(found.map((type) => type.kind));
  if (kinds.size === 1) return found[0];
  if (kinds.has('string') || loose) return types.string;

  throw unjoinable('a number and a boolean', at);
}

export function itemTypes(type: Type): readonly Type[] {
  if (type.kind === 'tuple') return type.elements;
  if (type.kind === 'object') return Object.values(type.attributes);

  return 'element' in type ? [type.element] : [];
}

type Join = (found: readonly Type[], at: Step[]) => Type;

type Tuple = Extract<Type, { kind: 'tuple' }>;

/** Tuples of one length stay a tuple, unified by position; anything else becomes a list, or a set if any is a set. */
function sequence(found: readonly Type[], at: Step[], join: Join): Type {
  const tuples = found.filter((type): type is Tuple => type.kind === 'tuple');
  const { length } = tuples[0]?.elements ?? [];
  if (tuples.length === found.length && tuples.every((tuple) => tuple.elements.length === length))
    return types.tuple(
      tuples[0].elements.map((_, index) =>
        join(
          tuples.map((tuple) => tuple.elements[index]),
          [...at, { key: index }]
        )
      )
    );

  const element = join(
    found.flatMap((type) => itemTypes(type)),
    at
  );
  return found.some((type) => type.kind === 'set') ? types.set(element) : types.list(element);
}

type ObjectType = Extract<Type, { kind: 'object' }>;

/** A name one of `found` has and another lacks. */
function otherName(found: readonly ObjectType[]): string | undefined {
  const names = Object.keys(found[0].attributes);
  for (const type of found) {
    const other = Object.keys(type.attributes).find((name) => !names.includes(name)) ?? names.find((name) => !Object.hasOwn(type.attributes, name));
    if (other !== undefined) return other;
  }

  return undefined;
}

/** Objects with different names usually mean a typo, so they are refused rather than unified as a map. */
function objects(found: readonly ObjectType[], at: Step[], join: Join): Type {
  const other = otherName(found);
  if (other !== undefined) throw unjoinable(`an object with "${other}" and one without it`, at);

  const names = Object.keys(found[0].attributes);
  const attributes = Object.fromEntries(
    names.map((name) => [
      name,
      join(
        found.map((type) => type.attributes[name]),
        [...at, { name }]
      ),
    ])
  );
  const optional = names.filter((name) => found.some((type) => type.optional?.includes(name)));
  return types.object(attributes, optional.length > 0 ? optional : undefined);
}

function mapping(found: readonly Type[], at: Step[], join: Join, loose: boolean): Type {
  // Beside a part still to come, which may be a map, objects of other names may still join as one.
  if (found.every((type): type is ObjectType => type.kind === 'object') && (!loose || otherName(found) === undefined)) return objects(found, at, join);

  return types.map(
    join(
      found.flatMap((type) => itemTypes(type)),
      at
    )
  );
}

/** A part of a value not known yet that has no type: once known it may be of any type, so what is joined with it has none unless a string holds it. */
const LATER: Type = { kind: 'dynamic' };

/**
 * As `unified`, with `later` at each place a part still to come of no type reaches. Below such a place the join is `loose`: once known,
 * the part may be a string, which holds any primitive, or a map, which holds objects of any names, so only what still could never join is refused.
 */
function joinedAs(found: readonly Type[], at: Step[], later: Type, loose = false): Type {
  const named = found.filter((type) => type.kind !== 'dynamic');
  if (named.length === 0) return found.includes(LATER) ? later : types.dynamic;

  const [first] = named;
  const other = named.find((type) => FAMILIES[type.kind] !== FAMILIES[first.kind]);
  if (other) throw unjoinable(`${article(first.kind)} and ${article(other.kind)}`, at);
  if (found.includes(LATER)) {
    joinedAs(named, at, later, true);
    // A string holds any primitive as text, and a structure beside it is refused at apply either way.
    return FAMILIES[first.kind] === 'primitive' && named.some((type) => type.kind === 'string') ? types.string : later;
  }

  const join: Join = (parts, within) => joinedAs(parts, within, later, loose);
  if (FAMILIES[first.kind] === 'primitive') return primitive(named, at, loose);
  return FAMILIES[first.kind] === 'sequence' ? sequence(named, at, join) : mapping(named, at, join, loose);
}

/** Throws `Unjoinable`. `dynamic` (an unknown or a null) fits any type, and what is joined with a part still to come of no type has none, unless a string holds it. `at` locates the types for the message. */
export function unified(found: readonly Type[], at: Step[] = []): Type {
  return joinedAs(found, at, types.dynamic);
}

/** The data at `step`, not known where the data is not. */
function dataAt(data: unknown, step: string | number): unknown {
  if (isUnknown(data)) return data;
  if (Array.isArray(data)) return data[Number(step)];

  return isRecord(data) ? own(data, String(step)) : undefined;
}

/** `type` with a part of no type still to come wherever one of `found`, each `type` with some such parts, has one. */
function laterUnion(type: Type, found: readonly Type[]): Type {
  if (found.includes(LATER)) return LATER;
  if (type.kind === 'tuple')
    return types.tuple(
      type.elements.map((element, index) =>
        laterUnion(
          element,
          found.map((each) => typeAt(each, index))
        )
      )
    );
  if (type.kind === 'object')
    return types.object(
      Object.fromEntries(
        Object.entries(type.attributes).map(([name, attribute]) => [
          name,
          laterUnion(
            attribute,
            found.map((each) => typeAt(each, name))
          ),
        ])
      ),
      type.optional && [...type.optional]
    );

  return 'element' in type
    ? types[type.kind](
        laterUnion(
          type.element,
          found.map((each) => typeAt(each, 0))
        )
      )
    : type;
}

/** The type of `data`, with each part not known yet that has no type as one that may be of any type. */
function laterType(type: Type, data: unknown): Type {
  if (type.kind === 'dynamic') return isUnknown(data) ? LATER : type;
  if (type.kind === 'tuple') return types.tuple(type.elements.map((element, index) => laterType(element, dataAt(data, index))));
  if (type.kind === 'object')
    return types.object(
      Object.fromEntries(Object.entries(type.attributes).map(([name, attribute]) => [name, laterType(attribute, dataAt(data, name))])),
      type.optional && [...type.optional]
    );
  if (!('element' in type)) return type;

  const items = Array.isArray(data) || isRecord(data) ? Object.values(data) : [data];
  return types[type.kind](
    laterUnion(
      type.element,
      items.map((item) => laterType(type.element, item))
    )
  );
}

/** The type the values of `map` share, with each part not known yet that has no type as one that may be of any type. */
export function elementLater(map: Value): Type {
  const type = laterType(map.type, map.data);
  return 'element' in type ? type.element : types.dynamic;
}

/** The type of `value`, with each part not known yet that has no type as one that may be of any type. */
export function laterOf(value: Value): Type {
  return laterType(value.type, value.data);
}

function hasLater(type: Type): boolean {
  return type === LATER || itemTypes(type).some((item) => hasLater(item));
}

function cleaned(type: Type): Type {
  if (type === LATER) return types.dynamic;
  if (!hasLater(type)) return type;
  if (type.kind === 'tuple') return types.tuple(type.elements.map((element) => cleaned(element)));
  if (type.kind === 'object')
    return types.object(Object.fromEntries(Object.entries(type.attributes).map(([name, attribute]) => [name, cleaned(attribute)])), type.optional && [...type.optional]);

  return 'element' in type ? types[type.kind](cleaned(type.element)) : type;
}

/** As `unified`, for types from `laterOf`, keeping each place a part still to come of no type reaches for `convertedLater`. */
export function joinedLater(found: readonly Type[], at: Step[] = []): Type {
  return joinedAs(found, at, LATER);
}

/** `value` with each part at a place still to come of `to` not known yet: once known, it may join into another type. A null is null in any type. */
function blankedParts(value: Value, to: Type): Value {
  if (to === LATER && value.data !== null) return valueOf(types.dynamic, UNKNOWN);
  if (!hasLater(to)) return value;

  if (Array.isArray(value.data)) return tupleOf(value.data.map((_, index) => blankedParts(child(value, index), typeAt(to, index))));
  if (isRecord(value.data)) return objectOf(Object.keys(value.data).map((name) => [name, blankedParts(child(value, name), typeAt(to, name))]));

  return value;
}

/** Each place stays where it was, so the value keeps all its marks. */
function blanked(value: Value, to: Type): Value {
  return withSensitive(blankedParts(value, to), value.sensitive ?? []);
}

/** As `converted`, to a type from `joinedLater`: a part a value of no type still to come reaches is not known until apply, and has no type. */
export function convertedLater(holder: string, value: Value, to: Type, path: AttributePath): Value {
  return converted(holder, blanked(value, to), cleaned(to), path);
}

/**
 * As `unified`, for the types of values, beside `written` types: where a value not known yet has no type, it may be of any type once known,
 * so what is joined with it has none unless a string holds it.
 */
export function unifiedLater(values: readonly Value[], at: Step[] = [], written: readonly Type[] = []): Type {
  return cleaned(joinedLater([...written, ...values.map((value) => laterOf(value))], at));
}
