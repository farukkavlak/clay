import { AttributePath, containsUnknown, ExactNumber, isRecord, Output, own, Type, typeAt, types } from '@clay/contracts';

/**
 * `data` is a string, an `ExactNumber`, a boolean, null, an array (list, set, tuple) or a record (map, object), with UNKNOWN at any depth.
 * A set's array holds each member once, in a fixed order. `type` is `dynamic` only for an unknown or a null of no type.
 * `sensitive` holds the steps to each sensitive part, and one empty path where the whole value is. A set is sensitive as a whole or not at all.
 */
export interface Value {
  readonly type: Type;
  readonly data: unknown;
  readonly sensitive?: readonly AttributePath[];
}

export function valueOf(type: Type, data: unknown): Value {
  return { type, data };
}

/** Left out where there are none, so a value with no sensitive part is the value it was. */
export function withSensitive({ type, data }: Value, paths: readonly AttributePath[]): Value {
  if (paths.length === 0) return { type, data };

  return { type, data, sensitive: paths.some((path) => path.length === 0) ? [[]] : paths };
}

export function allSensitive(value: Value): Value {
  return withSensitive(value, [[]]);
}

/** In any part. */
export function isSensitive(value: Value): boolean {
  return value.sensitive !== undefined;
}

export function isAllSensitive(value: Value): boolean {
  return value.sensitive?.some((path) => path.length === 0) === true;
}

/** The whole value where `sensitive`, and no part of it otherwise. */
export function wholeIf(sensitive: boolean): AttributePath[] {
  return sensitive ? [[]] : [];
}

/** Sensitive as a whole where `sensitive`, and as it was otherwise. */
export function allSensitiveIf(sensitive: boolean, result: Value): Value {
  return sensitive ? allSensitive(result) : result;
}

/** Stands in an error where a sensitive value would be quoted. */
export const HIDDEN = '(sensitive value)';

/** What is left of each path after `step`. A value sensitive as a whole is so in every part. */
export function sensitiveUnder(paths: readonly AttributePath[], step: string | number): AttributePath[] {
  if (paths.some((path) => path.length === 0)) return [[]];

  return paths.filter(([first]) => String(first) === String(step)).map((path) => path.slice(1));
}

function sensitiveIn(parts: [step: string | number, value: Value][]): AttributePath[] {
  return parts.flatMap(([step, value]) => (value.sensitive ?? []).map((path) => [step, ...path]));
}

/** A string, a number or a boolean. */
export function hasText(type: Type): boolean {
  return type.kind === 'string' || type.kind === 'number' || type.kind === 'bool';
}

export function tupleOf(values: Value[]): Value {
  const tuple = valueOf(
    types.tuple(values.map((value) => value.type)),
    values.map((value) => value.data)
  );

  return withSensitive(tuple, sensitiveIn(values.map((value, index) => [index, value])));
}

export function objectOf(entries: [name: string, value: Value][]): Value {
  const object = valueOf(
    types.object(Object.fromEntries(entries.map(([name, value]) => [name, value.type]))),
    Object.fromEntries(entries.map(([name, value]) => [name, value.data]))
  );

  return withSensitive(object, sensitiveIn(entries));
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

  return withSensitive(valueOf(type.kind === 'dynamic' ? inferred(data) : type, data), sensitiveUnder(value.sensitive ?? [], step));
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

/** As a plan or a state holds a value, beside its type and, for a root output, its flag. */
export function outputOf({ type, data }: Value, sensitive?: true): Output {
  return { value: data, type, ...(sensitive && { sensitive }) };
}

/** As a plan or a state holds each value, beside its type. */
export function carried(values: Record<string, Value>): Record<string, Output> {
  return Object.fromEntries(Object.entries(values).map(([name, value]) => [name, outputOf(value)]));
}
