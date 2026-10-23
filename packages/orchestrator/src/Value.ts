import { AttributePath, containsUnknown, EVERY_ITEM, ExactNumber, isRecord, isUnknown, Output, own, sensitiveUnder, Type, typeAt, types, UNKNOWN } from '@clay/contracts';

/**
 * `data` is a string, an `ExactNumber`, a boolean, null, an array (list, set, tuple) or a record (map, object), with UNKNOWN at any depth.
 * A set's array holds each member once, in a fixed order. `type` is `dynamic` only for an unknown or a null of no type.
 * `sensitive` holds the steps to each sensitive part, and one empty path where the whole value is. A set is sensitive as a whole or not at all.
 */
export interface Value {
  readonly type: Type;
  readonly data: unknown;
  readonly sensitive?: readonly AttributePath[];
  /** The reference a null was read through, so a refusal of it can say where it came from. */
  readonly nullFrom?: string;
}

export function valueOf(type: Type, data: unknown): Value {
  return { type, data };
}

/** Left out where there are none, so a value with no sensitive part is the value it was. */
export function withSensitive({ type, data, nullFrom }: Value, paths: readonly AttributePath[]): Value {
  const kept = nullFrom === undefined ? { type, data } : { type, data, nullFrom };
  if (paths.length === 0) return kept;

  return { ...kept, sensitive: paths.some((path) => path.length === 0) ? [[]] : paths };
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

/** Whether `paths` mark all of what is at `at`: a path to it, or to what holds it. */
function covers(paths: readonly AttributePath[], at: AttributePath): boolean {
  return paths.some((path) => path.length <= at.length && path.every((step, index) => step === EVERY_ITEM || String(step) === String(at[index])));
}

/** What both paths mark: the deeper of the two, with an item where the other says every item; none where they part. */
function meet(left: AttributePath, right: AttributePath): AttributePath | undefined {
  const steps: AttributePath = [];
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const [a, b] = [left[index], right[index]];
    if (a !== undefined && b !== undefined && a !== EVERY_ITEM && b !== EVERY_ITEM && String(a) !== String(b)) return undefined;
    steps.push(a === undefined || a === EVERY_ITEM ? (b ?? a) : a);
  }

  return steps;
}

/** Each once, and none that another already covers. */
export function fewest(paths: AttributePath[]): AttributePath[] {
  const keys = paths.map((path) => path.map(String).join('\0'));
  const once = paths.filter((_, index) => keys.indexOf(keys[index]) === index);

  return once.filter((path, index) => !covers([...once.slice(0, index), ...once.slice(index + 1)], path));
}

/** What both sets of marks mark. */
function meets(marks: AttributePath[], paths: readonly AttributePath[]): AttributePath[] {
  return marks.flatMap((mark) => paths.map((path) => meet(mark, path)).filter((met): met is AttributePath => met !== undefined));
}

/** The marks every one of `values` has, so a value that is one of them, not known which, has them for certain. */
export function sharedMarks(values: Value[]): AttributePath[] {
  const [first, ...rest] = values;
  if (first === undefined) return [];

  return fewest(rest.reduce((marks, value) => meets(marks, value.sensitive ?? []), [...(first.sensitive ?? [])]));
}

/** The marks of each item of what is not known yet, where each may be any of `values`. */
export function everyItemMarks(values: Value[]): AttributePath[] {
  return sharedMarks(values).map((path) => [EVERY_ITEM, ...path]);
}

/** Sensitive as a whole where `sensitive`, and as it was otherwise. */
export function allSensitiveIf(sensitive: boolean, result: Value): Value {
  return sensitive ? allSensitive(result) : result;
}

function sensitiveIn(parts: [step: string | number, value: Value][]): AttributePath[] {
  return parts.flatMap(([step, value]) => (value.sensitive ?? []).map((path) => [step, ...path]));
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

/** The items of `collection`; one not known yet stands for all of its items, with the marks every item has. */
export function itemsOf(collection: Value): Value[] {
  if (collection.data === null) return [];
  if (isUnknown(collection.data)) return [withSensitive(valueOf(types.dynamic, UNKNOWN), sensitiveUnder(collection.sensitive ?? [], EVERY_ITEM))];

  const steps = Array.isArray(collection.data) ? collection.data.map((_, index) => index) : Object.keys(collection.data as Record<string, unknown>);
  return steps.map((step) => child(collection, step));
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
