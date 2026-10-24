import { isRecord, isUnknown, own, Type, typeAt, types } from '@clay/contracts';
import { spellSteps, Step } from '@clay/parser';

import { article, Value } from './Value';

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

/** A string can hold numbers and bools as text; a number with a bool and no string is most often a mistake, so it is refused. */
function primitive(found: readonly Type[], at: Step[]): Type {
  const kinds = new Set(found.map((type) => type.kind));
  if (kinds.size === 1) return found[0];
  if (kinds.has('string')) return types.string;

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

/** Objects with different names usually mean a typo, so they are refused rather than unified as a map. */
function objects(found: readonly ObjectType[], at: Step[], join: Join): Type {
  const names = Object.keys(found[0].attributes);
  for (const type of found) {
    const other = Object.keys(type.attributes).find((name) => !names.includes(name)) ?? names.find((name) => !Object.hasOwn(type.attributes, name));
    if (other !== undefined) throw unjoinable(`an object with "${other}" and one without it`, at);
  }

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

function mapping(found: readonly Type[], at: Step[], join: Join): Type {
  if (found.every((type): type is ObjectType => type.kind === 'object')) return objects(found, at, join);

  return types.map(
    join(
      found.flatMap((type) => itemTypes(type)),
      at
    )
  );
}

/** A part of a value not known yet that has no type: once known it may take any shape, so a structure joined with it has none, as in HCL. */
const LATER: Type = { kind: 'dynamic' };

/** Throws `Unjoinable`. `dynamic` (an unknown or a null) fits any type, and a structure joined with a part still to come of no type has none. `at` locates the types for the message. */
export function unified(found: readonly Type[], at: Step[] = []): Type {
  const named = found.filter((type) => type.kind !== 'dynamic');
  if (named.length === 0) return types.dynamic;

  const [first] = named;
  const other = named.find((type) => FAMILIES[type.kind] !== FAMILIES[first.kind]);
  if (other) throw unjoinable(`${article(first.kind)} and ${article(other.kind)}`, at);
  if (found.includes(LATER) && FAMILIES[first.kind] !== 'primitive') return types.dynamic;

  if (FAMILIES[first.kind] === 'primitive') return primitive(named, at);
  return FAMILIES[first.kind] === 'sequence' ? sequence(named, at, unified) : mapping(named, at, unified);
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

/** The type of `data`, with each part not known yet that has no type as one that may take any shape. */
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

/** The type the values of `map` share, with each part not known yet that has no type as one that may take any shape. */
export function elementLater(map: Value): Type {
  const type = laterType(map.type, map.data);
  return 'element' in type ? type.element : types.dynamic;
}

/**
 * As `unified`, for the types of values, beside `written` types: where a value not known yet has no type, it may take any shape once known,
 * so a structure joined with it has none.
 */
export function unifiedLater(values: readonly Value[], at: Step[] = [], written: readonly Type[] = []): Type {
  unified([...written, ...values.map((value) => value.type)], at);

  return unified([...written, ...values.map((value) => laterType(value.type, value.data))], at);
}
