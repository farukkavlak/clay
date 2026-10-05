import { AttributePath, isRecord, Type, typeAt, types } from '@clay/contracts';
import { AttributeValue, TypeDefaults } from '@clay/parser';

import { converted, SchemaMismatch } from './conformValues';
import { setOf } from './setMembers';
import { itemTypes, unified, Unjoinable } from './unify';
import { child, objectOf, tupleOf, unordered, Value, valueOf } from './Value';

/** `read` evaluates a default, which is always a constant. */
export interface Defaults {
  tree: TypeDefaults;
  read: (node: AttributeValue) => Value;
}

type ObjectType = Extract<Type, { kind: 'object' }>;

/** Own keys only, since an attribute may be named `constructor`. */
function ownIn<T>(record: Record<string, T> | undefined, name: string | number): T | undefined {
  return record && Object.hasOwn(record, name) ? record[name] : undefined;
}

function namesAny(type: Type): boolean {
  return type.kind === 'dynamic' || itemTypes(type).some((item) => namesAny(item));
}

function namesOptional(type: Type): boolean {
  return (type.kind === 'object' && (type.optional?.length ?? 0) > 0) || itemTypes(type).some((item) => namesOptional(item));
}

/** Replaces each `any` with the found type; a collection's items share one type, as with `tolist`. */
function settled(declared: Type, found: Type): Type {
  if (!namesAny(declared)) return declared;
  if (declared.kind === 'dynamic') return found;

  if (declared.kind === 'object') return types.object(Object.fromEntries(Object.entries(declared.attributes).map(([name, type]) => [name, settled(type, typeAt(found, name))])));
  if (declared.kind === 'tuple') return types.tuple(declared.elements.map((type, index) => settled(type, typeAt(found, index))));
  if (declared.kind === 'list' || declared.kind === 'set' || declared.kind === 'map') return types[declared.kind](settled(declared.element, unified(itemTypes(found))));

  return declared;
}

/** After filling, every attribute is present, so all become required. */
function required(type: Type): Type {
  if (!namesOptional(type)) return type;
  if (type.kind === 'object') return types.object(Object.fromEntries(Object.entries(type.attributes).map(([name, attribute]) => [name, required(attribute)])));
  if (type.kind === 'tuple') return types.tuple(type.elements.map((element) => required(element)));

  return type.kind === 'list' || type.kind === 'set' || type.kind === 'map' ? types[type.kind](required(type.element)) : type;
}

/** `walk` is passed in because objects and their items recurse into each other. */
interface Fill {
  variable: string;
  read?: Defaults['read'];
  walk: (value: Value, declared: Type, defaults: TypeDefaults | undefined, path: AttributePath) => Value;
}

/** A missing or null optional attribute takes its default, or null if it has none. */
function attributeOf(value: Value, name: string, defaults: TypeDefaults | undefined, fill: Fill): Value {
  const data = value.data as Record<string, unknown>;
  const node = ownIn(defaults?.values, name);
  // `read` is always set when there are defaults.
  if (node && (!Object.hasOwn(data, name) || data[name] === null)) return fill.read!(node);

  return Object.hasOwn(data, name) ? child(value, name) : valueOf(types.dynamic, null);
}

/** Unknown names and missing required ones are kept as they are, so the conversion refuses them. */
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
 * A set stays a set where a set or list is declared, so a set with an unknown member keeps no order. Members are filled, then unified,
 * so two that a default makes equal are kept once. Where a tuple is declared, a set becomes a tuple unless it has no order yet.
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

/** Fills defaults first and converts once after, so `any` is inferred from the value with its defaults in it. */
function heldAs(value: Value, type: Type, defaults: TypeDefaults | undefined, fill: Fill, path: AttributePath): Value {
  try {
    const written = fill.walk(value, type, defaults, path);
    return converted(fill.variable, written, settled(required(type), written.type), path);
  } catch (error) {
    if (error instanceof Unjoinable) throw new SchemaMismatch(`${fill.variable} ${error.message}`, String(path[0]));
    throw error;
  }
}

/** Throws `SchemaMismatch` if the value does not fit the type. */
export function declaredAs(name: string, value: Value, type: Type, defaults?: Defaults): Value {
  return heldAs(value, type, defaults?.tree, fillWith(`variable "${name}"`, defaults?.read), [name]);
}

/** Without a declared type, the value is taken as it is. */
export function givenTo(name: string, value: Value, { type, defaults }: { type?: Type; defaults?: TypeDefaults }, read: Defaults['read']): Value {
  return type ? declaredAs(name, value, type, defaults && { tree: defaults, read }) : value;
}

/** Checks every default against its attribute's type, so a bad default is refused even when no value uses it. */
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
