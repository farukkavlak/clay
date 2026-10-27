import { AttributePath, containsUnknown, EVERY_ITEM, ExactNumber, isMaybe, isRecord, Marks, marksOnly, Output, own, Type, typeAt, types, UNKNOWN } from '@clay/contracts';

/**
 * `data` is a string, an `ExactNumber`, a boolean, null, an array (list, set, tuple) or a record (map, object), with UNKNOWN at any depth.
 * A set's array holds each member once, in a fixed order. `type` is `dynamic` only for an unknown or a null of no type.
 * `marks` holds, by their steps, the paths to each sensitive part, and one empty path where the whole value is. A set is sensitive as a whole or not at all.
 * A path that ends at SOMEWHERE says the part it reaches is sensitive somewhere the plan cannot name yet;
 * one that ends at MAYBE says the part, or any part in it, is sensitive in some outcome, so a root output must say it is.
 */
export interface Value {
  readonly type: Type;
  readonly data: unknown;
  readonly marks?: Marks;
  /** The reference a null was read through, so a refusal of it can say where it came from. */
  readonly nullFrom?: string;
}

export function valueOf(type: Type, data: unknown): Value {
  return { type, data };
}

/** The data with the part at `path` not known yet; under every item, that part of each item. */
function unknownAt(data: unknown, path: AttributePath): unknown {
  const [step, ...rest] = path;
  if (step === undefined) return UNKNOWN;
  if (!Array.isArray(data) && !isRecord(data)) return data;

  const at = (index: string | number) => step === EVERY_ITEM || String(step) === String(index);
  if (Array.isArray(data)) return data.map((item, index) => (at(index) ? unknownAt(item, rest) : item));
  return Object.fromEntries(Object.entries(data).map(([key, item]) => [key, at(key) ? unknownAt(item, rest) : item]));
}

function withMarks({ type, data, nullFrom }: Value, given: Marks): Value {
  const paths = given.paths();
  if (marksOnly(paths).length === 0) return nullFrom === undefined ? { type, data } : { type, data, nullFrom };

  const marks = given.whole() ? Marks.of([[]]) : given;
  const known = paths.filter((path) => isMaybe(path)).reduce((found, path) => unknownAt(found, path.slice(0, -1)), data);
  return { ...(nullFrom === undefined ? { type, data: known } : { type, data: known, nullFrom }), marks };
}

/**
 * Left out where there are none, so a value with no sensitive part is the value it was.
 * A part that only may be sensitive is not known yet either, so nothing shows it or takes it as known before the apply says.
 */
export function withSensitive(value: Value, paths: readonly AttributePath[]): Value {
  return withMarks(value, Marks.of(paths));
}

/** The steps to each sensitive part of the value. */
export function sensitiveOf(value: Value): readonly AttributePath[] {
  return value.marks?.paths() ?? [];
}

export function allSensitive(value: Value): Value {
  return withSensitive(value, [[]]);
}

/** Sensitive somewhere the plan cannot name, as a whole and not only in a part. */
export function sensitiveSomewhere(value: Value): boolean {
  return value.marks?.somewhere() ?? false;
}

export function isAllSensitive(value: Value): boolean {
  return value.marks?.whole() ?? false;
}

/** In any part, in some outcome: a mark of any kind, for certain or not. */
export function mayBeSensitive(value: Value): boolean {
  return value.marks !== undefined;
}

/** The whole value where `sensitive`, and no part of it otherwise. */
export function wholeIf(sensitive: boolean): AttributePath[] {
  return sensitive ? [[]] : [];
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

  const found = valueOf(type.kind === 'dynamic' ? inferred(data) : type, data);

  return value.marks ? withMarks(found, value.marks.under(step)) : found;
}

/** Sensitive as a whole where `sensitive`, and as it was otherwise. */
export function allSensitiveIf(sensitive: boolean, result: Value): Value {
  return sensitive ? allSensitive(result) : result;
}

function sensitiveIn(parts: [step: string | number, value: Value][]): AttributePath[] {
  return parts.flatMap(([step, value]) => sensitiveOf(value).map((path) => [step, ...path]));
}

/** The steps to each sensitive part of the values, from their names on. */
export function sensitiveAmong(values: Record<string, Value>): AttributePath[] {
  return sensitiveIn(Object.entries(values));
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

/** Where a null came from, when a reference gave it. */
export function nullSource(value: Value | undefined): string {
  return value?.nullFrom === undefined ? '' : `, and ${value.nullFrom}, which it reads, is null`;
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
