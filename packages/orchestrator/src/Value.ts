import { containsUnknown, ExactNumber, isRecord, Output, own, Type, typeAt, types } from '@clay/contracts';

/**
 * `data` is a string, an `ExactNumber`, a boolean, null, an array (list, set, tuple) or a record (map, object), with UNKNOWN at any depth.
 * A set's array holds each member once, in a fixed order. `type` is `dynamic` only for an unknown or a null of no type.
 */
export interface Value {
  readonly type: Type;
  readonly data: unknown;
}

export function valueOf(type: Type, data: unknown): Value {
  return { type, data };
}

/** A string, a number or a boolean. */
export function hasText(type: Type): boolean {
  return type.kind === 'string' || type.kind === 'number' || type.kind === 'bool';
}

export function tupleOf(values: Value[]): Value {
  return valueOf(
    types.tuple(values.map((value) => value.type)),
    values.map((value) => value.data)
  );
}

export function objectOf(entries: [name: string, value: Value][]): Value {
  return valueOf(types.object(Object.fromEntries(entries.map(([name, value]) => [name, value.type]))), Object.fromEntries(entries.map(([name, value]) => [name, value.data])));
}

/** An array is a tuple and a record an object. */
export function inferred(data: unknown): Type {
  if (typeof data === 'string') return types.string;
  if (data instanceof ExactNumber) return types.number;
  if (typeof data === 'boolean') return types.bool;
  if (Array.isArray(data)) return types.tuple(data.map((item) => inferred(item)));
  if (isRecord(data)) return types.object(Object.fromEntries(Object.entries(data).map(([name, item]) => [name, inferred(item)])));

  return types.dynamic;
}

/** Undefined data where the step finds nothing. */
export function child(value: Value, step: string | number): Value {
  const data = Array.isArray(value.data) ? value.data[step as number] : own(value.data as Record<string, unknown>, String(step));
  const type = typeAt(value.type, step);

  return valueOf(type.kind === 'dynamic' ? inferred(data) : type, data);
}

/** A set with an unknown member has no order or size until apply. */
export function unordered(value: Value): boolean {
  return value.type.kind === 'set' && Array.isArray(value.data) && value.data.some((member) => containsUnknown(member));
}

const ARTICLES: Record<Type['kind'], string> = {
  string: 'a string',
  number: 'a number',
  bool: 'a boolean',
  dynamic: 'any value',
  list: 'a list',
  set: 'a set',
  map: 'a map',
  object: 'an object',
  tuple: 'a tuple',
};

/** `a list`, `an object`. */
export function article(kind: Type['kind']): string {
  return ARTICLES[kind];
}

export function described(value: Value): string {
  return value.data === null ? 'null' : article(value.type.kind);
}

/** The data alone, as providers, plans and state hold it; the schema types it again when read. */
export function plainOf(values: Record<string, Value>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).map(([name, value]) => [name, value.data]));
}

/** As a plan or a state holds each value, beside its type. */
export function carried(values: Record<string, Value>): Record<string, Output> {
  return Object.fromEntries(Object.entries(values).map(([name, { type, data }]) => [name, { value: data, type }]));
}
