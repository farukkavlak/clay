import { AttributePath, isRecord, Type, typeAt, types } from '@clay/contracts';
import { AttributeValue, TypeDefaults } from '@clay/parser';

import { converted, SchemaMismatch } from './conformValues';
import { setOf } from './setMembers';
import { itemTypes, unified, Unjoinable } from './unify';
import { child, objectOf, tupleOf, unordered, Value, valueOf } from './Value';

/** The defaults a variable's type gives, and how to read one: each is a constant written in the type. */
export interface Defaults {
  tree: TypeDefaults;
  read: (node: AttributeValue) => Value;
}

type ObjectType = Extract<Type, { kind: 'object' }>;

/** What a record of defaults holds under the name: an attribute may be named `constructor`, which every object inherits. */
function ownIn<T>(record: Record<string, T> | undefined, name: string | number): T | undefined {
  return record && Object.hasOwn(record, name) ? record[name] : undefined;
}

function namesAny(type: Type): boolean {
  return type.kind === 'dynamic' || itemTypes(type).some((item) => namesAny(item));
}

function namesOptional(type: Type): boolean {
  return (type.kind === 'object' && (type.optional?.length ?? 0) > 0) || itemTypes(type).some((item) => namesOptional(item));
}

/** The declared type with each `any` in it taken from what was found there; a collection's items share one type, as `tolist` gives them. */
function settled(declared: Type, found: Type): Type {
  if (!namesAny(declared)) return declared;
  if (declared.kind === 'dynamic') return found;

  if (declared.kind === 'object') return types.object(Object.fromEntries(Object.entries(declared.attributes).map(([name, type]) => [name, settled(type, typeAt(found, name))])));
  if (declared.kind === 'tuple') return types.tuple(declared.elements.map((type, index) => settled(type, typeAt(found, index))));
  if (declared.kind === 'list' || declared.kind === 'set' || declared.kind === 'map') return types[declared.kind](settled(declared.element, unified(itemTypes(found))));

  return declared;
}

/** Every attribute is there once filled in, so the type it is held to requires each. */
function required(type: Type): Type {
  if (!namesOptional(type)) return type;
  if (type.kind === 'object') return types.object(Object.fromEntries(Object.entries(type.attributes).map(([name, attribute]) => [name, required(attribute)])));
  if (type.kind === 'tuple') return types.tuple(type.elements.map((element) => required(element)));

  return type.kind === 'list' || type.kind === 'set' || type.kind === 'map' ? types[type.kind](required(type.element)) : type;
}

/** What filling a value in needs at each depth; `walk` is the fill itself, handed in since an object and its items call one another. */
interface Fill {
  variable: string;
  read?: Defaults['read'];
  walk: (value: Value, declared: Type, defaults: TypeDefaults | undefined, path: AttributePath) => Value;
}

/** An optional attribute left out, or null, takes its default as written, or else null; one given keeps its value. */
function attributeOf(value: Value, name: string, defaults: TypeDefaults | undefined, fill: Fill): Value {
  const data = value.data as Record<string, unknown>;
  const node = ownIn(defaults?.values, name);
  // A tree of defaults comes only with how to read them.
  if (node && (!Object.hasOwn(data, name) || data[name] === null)) return fill.read!(node);

  return Object.hasOwn(data, name) ? child(value, name) : valueOf(types.dynamic, null);
}

/** A name the type does not have is kept, so the conversion refuses it; a required one left out stays out for the same reason. */
function filledObject(value: Value, declared: ObjectType, defaults: TypeDefaults | undefined, fill: Fill, path: AttributePath): Value {
  const names = new Set([...Object.keys(value.data as Record<string, unknown>), ...(declared.optional ?? [])]);

  return objectOf(
    [...names].map((name) => {
      if (!Object.hasOwn(declared.attributes, name)) return [name, child(value, name)];
      return [name, fill.walk(attributeOf(value, name, defaults, fill), declared.attributes[name], ownIn(defaults?.within, name), [...path, name])];
    })
  );
}

/**
 * A set given where a set or a list goes stays a set, so one with a member not known yet keeps no order. Each member is held to the type declared for it,
 * `any` kept as found, and then all to the type they join into, so two a default makes equal are held once. Given where a tuple goes, whose places can
 * name other types, it is a tuple as any other sequence is, unless it has no order yet.
 */
function filledSequence(value: Value, declared: Type, defaults: TypeDefaults | undefined, fill: Fill, path: AttributePath): Value {
  if (declared.kind === 'tuple' && unordered(value)) return value;

  const within = (index: number) => (declared.kind === 'tuple' ? ownIn(defaults?.within, index) : defaults?.element);
  const items = (value.data as unknown[]).map((_, index) => fill.walk(child(value, index), typeAt(declared, index), within(index), [...path, index]));
  if (value.type.kind !== 'set' || declared.kind === 'tuple') return tupleOf(items);

  const held = items.map((item, index) => converted(fill.variable, item, settled(typeAt(declared, index), item.type), [...path, index]));
  const joined = unified(held.map((item) => item.type));
  return valueOf(types.set(joined), setOf(held.map((item, index) => converted(fill.variable, item, joined, [...path, index]).data)));
}

/** The value as written with each optional attribute in it that is left out, or null, given its default, or null where its type names none. */
function filled(value: Value, declared: Type, defaults: TypeDefaults | undefined, fill: Fill, path: AttributePath): Value {
  if (!namesOptional(declared)) return value;

  const isMapping = declared.kind === 'object' || declared.kind === 'map';
  if (isMapping !== isRecord(value.data) || (!isMapping && !Array.isArray(value.data))) return value;

  if (declared.kind === 'object') return filledObject(value, declared, defaults, fill, path);
  if (declared.kind === 'map')
    return objectOf(Object.keys(value.data as Record<string, unknown>).map((name) => [name, fill.walk(child(value, name), declared.element, defaults?.element, [...path, name])]));

  return filledSequence(value, declared, defaults, fill, path);
}

function fillWith(variable: string, read: Defaults['read'] | undefined): Fill {
  const fill: Fill = { variable, read, walk: (value, declared, defaults, path) => filled(value, declared, defaults, fill, path) };
  return fill;
}

/** Filled in first and converted once after, as Terraform does, so `any` is read from the value with its defaults in it. */
function heldAs(value: Value, type: Type, defaults: TypeDefaults | undefined, fill: Fill, path: AttributePath): Value {
  try {
    const written = fill.walk(value, type, defaults, path);
    return converted(fill.variable, written, settled(required(type), written.type), path);
  } catch (error) {
    if (error instanceof Unjoinable) throw new SchemaMismatch(`${fill.variable} ${error.message}`, String(path[0]));
    throw error;
  }
}

/** A variable's value as the type the variable names, its optional attributes filled in, or a `SchemaMismatch` that says why it cannot be. */
export function declaredAs(name: string, value: Value, type: Type, defaults?: Defaults): Value {
  return heldAs(value, type, defaults?.tree, fillWith(`variable "${name}"`, defaults?.read), [name]);
}

/** A value given to a variable, held to the type it declares with the defaults that type gives, which can make a value refused; one without a type takes it as it is. */
export function givenTo(name: string, value: Value, { type, defaults }: { type?: Type; defaults?: TypeDefaults }, read: Defaults['read']): Value {
  return type ? declaredAs(name, value, type, defaults && { tree: defaults, read }) : value;
}

/** Each default the type gives, read and held to its attribute's type with the defaults inside it, so one that could never be taken is refused though no value leaves it out. */
export function checkDefaults(name: string, type: Type, defaults: Defaults, at: (node: AttributeValue, check: () => void) => void): void {
  const fill = fillWith(`variable "${name}"`, defaults.read);

  const visit = (declared: Type, tree: TypeDefaults | undefined): void => {
    if (!tree) return;
    if (declared.kind === 'list' || declared.kind === 'set' || declared.kind === 'map') {
      visit(declared.element, tree.element);
      return;
    }

    for (const [step, within] of Object.entries(tree.within ?? {})) visit(typeAt(declared, declared.kind === 'tuple' ? Number(step) : step), within);
    for (const [attribute, node] of Object.entries(tree.values ?? {})) {
      const attributeType = typeAt(declared, attribute);
      at(node, () => heldAs(defaults.read(node), attributeType, ownIn(tree.within, attribute), fill, [attribute]));
    }
  };
  visit(type, defaults.tree);
}
