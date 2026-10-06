import { AttributePath, ExactNumber, isRecord, isUnknown, Schema, Type, typeIn } from '@clay/contracts';

import { setOf } from './setMembers';
import { items, spelled } from './spelled';
import { article, inferred, Value, valueOf } from './Value';
import { ObjectType, withLeftOut } from './withLeftOut';

export class TypeMismatch extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TypeMismatch';
  }
}

/** Describes untyped data by its JavaScript shape. */
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

type Read = (type: Type, data: unknown, path: AttributePath) => unknown;

function entriesTyped(data: Record<string, unknown>, typeOf: (name: string) => Type, path: AttributePath, read: Read): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).map(([name, item]) => [name, read(typeOf(name), item, [...path, name])]));
}

/** Every non-optional attribute, and no other. */
function checkNames(type: ObjectType, data: Record<string, unknown>, path: AttributePath): void {
  const other = Object.keys(data).find((name) => !Object.hasOwn(type.attributes, name));
  if (other !== undefined) throw new TypeMismatch(`${spelled(path)} has "${other}", which its type does not`);

  const missing = Object.keys(type.attributes).find((name) => !Object.hasOwn(data, name) && !type.optional?.includes(name));
  if (missing !== undefined) throw new TypeMismatch(`${spelled(path)} has no "${missing}", which its type requires`);
}

function tupleItems(type: Extract<Type, { kind: 'tuple' }>, data: unknown[], path: AttributePath, read: Read): unknown[] {
  if (data.length !== type.elements.length) throw new TypeMismatch(`${spelled(path)} holds ${items(data.length)}, where its type has ${items(type.elements.length)}`);

  return data.map((item, index) => read(type.elements[index], item, [...path, index]));
}

function held(type: Type, data: unknown, path: AttributePath, read: Read): unknown {
  if (type.kind === 'tuple') return tupleItems(type, data as unknown[], path, read);
  if (type.kind === 'object') {
    checkNames(type, data as Record<string, unknown>, path);
    return withLeftOut(
      type,
      entriesTyped(data as Record<string, unknown>, (name) => type.attributes[name], path, read)
    );
  }
  if (type.kind === 'map') return entriesTyped(data as Record<string, unknown>, () => type.element, path, read);
  if (type.kind !== 'list' && type.kind !== 'set') return data;

  const elements = (data as unknown[]).map((item, index) => read(type.element, item, [...path, index]));
  return type.kind === 'set' ? setOf(elements) : elements;
}

/**
 * Reads provider or state data as `type`. Nothing is converted: data of another type is refused with its path.
 * Sets come back ordered and deduplicated. For `dynamic`, the type is inferred from the data.
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

/** An undefined attribute counts as missing, as the state file drops it. In a list it keeps its place, so it is refused. */
function withoutUnset(data: unknown): unknown {
  if (Array.isArray(data)) return data.map((item) => withoutUnset(item));
  if (!isRecord(data)) return data;

  const set = Object.entries(data).filter(([, item]) => item !== undefined);
  return Object.fromEntries(set.map(([name, item]) => [name, withoutUnset(item)]));
}

/** A name outside the schema gets the type inferred from its data. */
export function typedValues(schema: Schema, values: Record<string, unknown>): Record<string, Value> {
  const set = Object.entries(withoutUnset(values) as Record<string, unknown>);

  return Object.fromEntries(set.map(([name, data]) => [name, typed(typeIn(schema, name), data, [name])]));
}
