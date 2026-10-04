import { AttributePath, ExactNumber, isRecord, isUnknown, Schema, Type, typeIn } from '@clay/contracts';

import { setOf } from './setMembers';
import { items, spelled } from './spelled';
import { article, inferred, Value, valueOf } from './Value';

/** Plain data that does not hold the type it is said to have. */
export class TypeMismatch extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TypeMismatch';
  }
}

/** What plain data is, in the words of the JavaScript that holds it, since data that holds no type may be anything. */
function kind(data: unknown): string {
  if (data instanceof ExactNumber) return 'an exact number';
  if (typeof data === 'number') return 'a JavaScript number';
  if (Array.isArray(data)) return 'a list';
  if (isRecord(data)) return 'a map';

  if (data === null || data === undefined) return String(data);

  return `a ${typeof data}`;
}

function holds(type: Type, data: unknown): boolean {
  if (type.kind === 'string') return typeof data === 'string';
  if (type.kind === 'number') return data instanceof ExactNumber;
  if (type.kind === 'bool') return typeof data === 'boolean';
  if (type.kind === 'list' || type.kind === 'set' || type.kind === 'tuple') return Array.isArray(data);

  return isRecord(data);
}

/** Reads one part of the data as the type its place names, and gives back its data. */
type Read = (type: Type, data: unknown, path: AttributePath) => unknown;

function entriesTyped(data: Record<string, unknown>, typeOf: (name: string) => Type, path: AttributePath, read: Read): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).map(([name, item]) => [name, read(typeOf(name), item, [...path, name])]));
}

/** An object holds each attribute its type names, all but the optional ones, and no other. */
function checkNames(type: Extract<Type, { kind: 'object' }>, data: Record<string, unknown>, path: AttributePath): void {
  const other = Object.keys(data).find((name) => !Object.hasOwn(type.attributes, name));
  if (other !== undefined) throw new TypeMismatch(`${spelled(path)} has "${other}", which its type does not`);

  const missing = Object.keys(type.attributes).find((name) => !Object.hasOwn(data, name) && !type.optional?.includes(name));
  if (missing !== undefined) throw new TypeMismatch(`${spelled(path)} has no "${missing}", which its type requires`);
}

function tupleItems(type: Extract<Type, { kind: 'tuple' }>, data: unknown[], path: AttributePath, read: Read): unknown[] {
  if (data.length !== type.elements.length) throw new TypeMismatch(`${spelled(path)} holds ${items(data.length)}, where its type has ${items(type.elements.length)}`);

  return data.map((item, index) => read(type.elements[index], item, [...path, index]));
}

/** What the data holds, each part held to the type its place names. */
function held(type: Type, data: unknown, path: AttributePath, read: Read): unknown {
  if (type.kind === 'tuple') return tupleItems(type, data as unknown[], path, read);
  if (type.kind === 'object') {
    checkNames(type, data as Record<string, unknown>, path);
    return entriesTyped(data as Record<string, unknown>, (name) => type.attributes[name], path, read);
  }
  if (type.kind === 'map') return entriesTyped(data as Record<string, unknown>, () => type.element, path, read);
  if (type.kind !== 'list' && type.kind !== 'set') return data;

  const elements = (data as unknown[]).map((item, index) => read(type.element, item, [...path, index]));
  return type.kind === 'set' ? setOf(elements) : elements;
}

/**
 * Plain data, as a provider or a state holds it, read as the type it is said to have. Nothing is converted: data that holds another type is refused,
 * named by the steps to it. Each set comes back in one order, with each member once. Data of a `dynamic` type has the type its shape gives it.
 */
export function typed(type: Type, data: unknown, path: AttributePath): Value {
  if (isUnknown(data) || data === null) return valueOf(type, data);

  if (type.kind === 'dynamic') {
    const found = inferred(data);
    if (found.kind === 'dynamic') throw new TypeMismatch(`${spelled(path)} is ${kind(data)}, which is no value Clay holds`);
    return typed(found, data, path);
  }

  if (!holds(type, data)) throw new TypeMismatch(`${spelled(path)} is ${kind(data)}, where its type is ${article(type.kind)}`);

  return valueOf(
    type,
    held(type, data, path, (part, item, at) => typed(part, item, at).data)
  );
}

/** A name given no value is a name left out, as the state file drops it. In a list it has a place, so it stays and is refused. */
function withoutUnset(data: unknown): unknown {
  if (Array.isArray(data)) return data.map((item) => withoutUnset(item));
  if (!isRecord(data)) return data;

  const set = Object.entries(data).filter(([, item]) => item !== undefined);
  return Object.fromEntries(set.map(([name, item]) => [name, withoutUnset(item)]));
}

/** A resource's or a data source's values, each read as the type the schema names; one the schema does not name has the type its shape gives it. */
export function typedValues(schema: Schema, values: Record<string, unknown>): Record<string, Value> {
  const set = Object.entries(withoutUnset(values) as Record<string, unknown>);

  return Object.fromEntries(set.map(([name, data]) => [name, typed(typeIn(schema, name), data, [name])]));
}
