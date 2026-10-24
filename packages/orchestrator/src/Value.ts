import {
  AttributePath,
  containsUnknown,
  EVERY_ITEM,
  ExactNumber,
  isMarker,
  isMaybe,
  isRecord,
  isUnknown,
  MAYBE,
  Output,
  own,
  sensitiveUnder,
  SOMEWHERE,
  Type,
  typeAt,
  types,
  UNKNOWN,
} from '@clay/contracts';

/**
 * `data` is a string, an `ExactNumber`, a boolean, null, an array (list, set, tuple) or a record (map, object), with UNKNOWN at any depth.
 * A set's array holds each member once, in a fixed order. `type` is `dynamic` only for an unknown or a null of no type.
 * `sensitive` holds the steps to each sensitive part, and one empty path where the whole value is. A set is sensitive as a whole or not at all.
 * A path that ends at SOMEWHERE says the part it reaches is sensitive somewhere the plan cannot name yet;
 * one that ends at MAYBE says the part, or any part in it, is sensitive in some outcome, so a root output must say it is.
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

/** The data with the part at `path` not known yet; under every item, that part of each item. */
function unknownAt(data: unknown, path: AttributePath): unknown {
  const [step, ...rest] = path;
  if (step === undefined) return UNKNOWN;
  if (!Array.isArray(data) && !isRecord(data)) return data;

  const at = (index: string | number) => step === EVERY_ITEM || String(step) === String(index);
  if (Array.isArray(data)) return data.map((item, index) => (at(index) ? unknownAt(item, rest) : item));
  return Object.fromEntries(Object.entries(data).map(([key, item]) => [key, at(key) ? unknownAt(item, rest) : item]));
}

/**
 * Left out where there are none, so a value with no sensitive part is the value it was.
 * A part that only may be sensitive is not known yet either, so nothing shows it or takes it as known before the apply says.
 */
export function withSensitive({ type, data, nullFrom }: Value, paths: readonly AttributePath[]): Value {
  if (paths.length === 0) return nullFrom === undefined ? { type, data } : { type, data, nullFrom };

  const marks = paths.some((path) => path.length === 0) ? [[]] : paths;
  const known = marks.filter((path) => isMaybe(path)).reduce((found, path) => unknownAt(found, path.slice(0, -1)), data);
  return { ...(nullFrom === undefined ? { type, data: known } : { type, data: known, nullFrom }), sensitive: marks };
}

export function allSensitive(value: Value): Value {
  return withSensitive(value, [[]]);
}

const named = (step: string | number | undefined): step is string | number => step !== undefined && !isMarker(step);

/** A step a value not known yet holds in every outcome: its type names it, or a mark does, since a certain mark names only a part every outcome has and none lies under a maybe one. */
function laterHolds(type: Type, marks: readonly AttributePath[], step: string | number): boolean {
  if (type.kind === 'object' && Object.hasOwn(type.attributes, String(step))) return true;
  if (type.kind === 'tuple' && Number(step) < type.elements.length) return true;

  return marks.some(([first]) => named(first) && String(first) === String(step));
}

/** The parts of known data at a step: every item for EVERY_ITEM, none where the step finds nothing. */
function partsAt(data: unknown, step: string | number): unknown[] {
  if (!Array.isArray(data) && !isRecord(data)) return [];
  if (step === EVERY_ITEM) return Object.values(data);

  const part = Array.isArray(data) ? data[Number(step)] : own(data, String(step));
  return part === undefined ? [] : [part];
}

/**
 * Whether every outcome of the value has the part at `path`; under EVERY_ITEM, every item has it. SOMEWHERE is a part there is.
 * Where `oneItem`, EVERY_ITEM also needs an item to be there, which a collection not known yet may lack.
 */
function holds(data: unknown, type: Type, marks: readonly AttributePath[], path: AttributePath, oneItem: boolean): boolean {
  const [step, ...rest] = path;
  if (step === undefined || step === SOMEWHERE) return true;
  if (step === MAYBE) return false;

  const below = (part: unknown) => holds(part, typeAt(type, step), sensitiveUnder(marks, step), rest, oneItem);
  if (isUnknown(data)) return (step === EVERY_ITEM ? !oneItem : laterHolds(type, marks, step)) && below(UNKNOWN);

  const parts = partsAt(data, step);
  return step === EVERY_ITEM && !oneItem ? parts.every((part) => below(part)) : parts.some((part) => below(part));
}

/** Whether each of `values` has the part at `path` in every outcome. */
function allHold(values: Value[], path: AttributePath, oneItem: boolean): boolean {
  return values.every((value) => holds(value.data, value.type, value.sensitive ?? [], path, oneItem));
}

/** In any part, for certain: a mark under every item of a collection not known yet, which may come out empty, marks nothing for certain. */
export function isSensitive(value: Value): boolean {
  return value.sensitive?.some((path) => allHold([value], path, true)) === true;
}

/** Sensitive somewhere the plan cannot name, as a whole and not only in a part. */
export function sensitiveSomewhere(value: Value): boolean {
  return value.sensitive?.some((path) => path.length === 1 && path[0] === SOMEWHERE) === true;
}

export function isAllSensitive(value: Value): boolean {
  return value.sensitive?.some((path) => path.length === 0) === true;
}

/** In any part, in some outcome: a mark of any kind, for certain or not. */
export function mayBeSensitive(value: Value): boolean {
  return value.sensitive !== undefined;
}

/** The whole value where `sensitive`, and no part of it otherwise. */
export function wholeIf(sensitive: boolean): AttributePath[] {
  return sensitive ? [[]] : [];
}

/** Sensitive as a whole where one of `values` is in any part for certain; else it may be as a whole where one may be in any part. */
export function wholeOf(...values: Value[]): AttributePath[] {
  if (values.some((value) => isSensitive(value))) return [[]];

  return values.some((value) => mayBeSensitive(value)) ? [[MAYBE]] : [];
}

/** The same part, as one that may be sensitive: what is sensitive somewhere may be at any part of it. */
function maybeOf(path: AttributePath): AttributePath {
  if (isMaybe(path)) return path;

  return [...(path.at(-1) === SOMEWHERE ? path.slice(0, -1) : path), MAYBE];
}

/** Whether a step of a mark reaches the step `at` names. Every item reaches no named one, which may not be there. */
function reaches(step: string | number, at: string | number): boolean {
  return isMarker(step) || isMarker(at) ? step === at : String(step) === String(at);
}

/** Whether a mark at `path`, of either kind, means every part at `within` may be sensitive. Under every item, the item may be. */
function coversMaybe(path: AttributePath, within: AttributePath): boolean {
  return path.length <= within.length && path.every((step, index) => step === EVERY_ITEM || reaches(step, within[index]));
}

/**
 * Whether `paths` mark all of what is at `at`: a path to it, or to what holds it.
 * Where `at` is sensitive somewhere, a mark inside it covers it only if it is there for certain, so not one under every item.
 * Where `at` may be sensitive, any mark that may be so at or above it covers it, and none for certain is covered by one that may be.
 */
function covers(paths: readonly AttributePath[], at: AttributePath): boolean {
  if (isMaybe(at)) return paths.some((path) => coversMaybe(isMaybe(path) ? path.slice(0, -1) : path, at.slice(0, -1)));

  const somewhere = at.at(-1) === SOMEWHERE;
  const within = somewhere ? at.slice(0, -1) : at;
  const fits = (path: AttributePath) => !isMaybe(path) && (somewhere ? !path.slice(within.length).includes(EVERY_ITEM) : path.length <= at.length);

  return paths.some((path) => fits(path) && path.slice(0, within.length).every((step, index) => reaches(step, within[index])));
}

/** Where two marks part, the value is still sensitive somewhere in what both hold, if each mark is there for certain past the steps they share. */
function parted(steps: AttributePath, [left, right]: AttributePath[], [lefts, rights]: Value[][]): AttributePath | undefined {
  const certain = (path: AttributePath, values: Value[]) => allHold(values, [...steps, ...path.slice(steps.length)], true);

  return certain(left, lefts) && certain(right, rights) ? [...steps, SOMEWHERE] : undefined;
}

/** A step only one side names is kept only where the other side's values hold it, so a mark names only a part every outcome has. */
function taken(steps: AttributePath, [a, b]: (string | number | undefined)[], [lefts, rights]: Value[][]): string | number | undefined {
  const step = named(a) ? a : (b ?? a);
  if (named(step) && !(named(a) && named(b)) && !allHold(named(a) ? rights : lefts, [...steps, step], false)) return undefined;

  return step;
}

/** What both paths mark: the deeper of the two, with an item where the other says every item. */
function meet(left: AttributePath, right: AttributePath, sides: Value[][]): AttributePath | undefined {
  const steps: AttributePath = [];
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const [a, b] = [left[index], right[index]];
    if (a === SOMEWHERE || b === SOMEWHERE || (named(a) && named(b) && String(a) !== String(b))) return parted(steps, [left, right], sides);

    const step = taken(steps, [a, b], sides);
    if (step === undefined) return undefined;
    steps.push(step);
  }

  return steps;
}

/** Each once, and none that another already covers. */
export function fewest(paths: AttributePath[]): AttributePath[] {
  const keys = paths.map((path) => JSON.stringify(path.map((step) => (isMarker(step) ? step : String(step)))));
  const once = paths.filter((_, index) => keys.indexOf(keys[index]) === index);

  return once.filter((path, index) => !covers([...once.slice(0, index), ...once.slice(index + 1)], path));
}

/** What both sets of marks mark: those of `lefts`, shared so far, and those of `right`. */
function meets(marks: AttributePath[], lefts: Value[], right: Value): AttributePath[] {
  return marks.flatMap((mark) => (right.sensitive ?? []).map((path) => meet(mark, path, [lefts, [right]])).filter((met): met is AttributePath => met !== undefined));
}

/** The marks every one of `values` has, so a value that is one of them, not known which, has them for certain, and those any has as ones it may have. */
export function sharedMarks(values: Value[]): AttributePath[] {
  const certain = values.map((value) =>
    withSensitive(
      value,
      (value.sensitive ?? []).filter((path) => !isMaybe(path))
    )
  );
  const maybe = values.flatMap((value) => (value.sensitive ?? []).filter((path) => path.at(-1) !== SOMEWHERE).map((path) => maybeOf(path)));
  const [first, ...rest] = certain;
  if (first === undefined) return [];

  return fewest([...rest.reduce((marks, value, index) => meets(marks, certain.slice(0, index + 1), value), [...(first.sensitive ?? [])]), ...maybe]);
}

/** The marks of each item of what is not known yet, where each may be any of `values`. */
export function everyItemMarks(values: Value[]): AttributePath[] {
  return sharedMarks(values).map((path) => [EVERY_ITEM, ...path]);
}

/** Sensitive as a whole where `sensitive`, and as it was otherwise. */
export function allSensitiveIf(sensitive: boolean, result: Value): Value {
  return sensitive ? allSensitive(result) : result;
}

/** As a whole, in some outcome. */
export function mayBeAllSensitive(value: Value): boolean {
  return isAllSensitive(value) || value.sensitive?.some((path) => path.length === 1 && path[0] === MAYBE) === true;
}

/** Sensitive as a whole where `sensitive`; else, where `maybe`, it may be as a whole beside the marks it has. */
export function wholeWhere(result: Value, sensitive: boolean, maybe: boolean): Value {
  if (sensitive) return allSensitive(result);

  return maybe ? withSensitive(result, fewest([...(result.sensitive ?? []), [MAYBE]])) : result;
}

/** Whether a value is sensitive as a whole, and whether it may be. */
export interface Whole {
  sensitive: boolean;
  maybe: boolean;
}

/** The whole where `whole` is sensitive; else `marks`, and the whole as one that may be where it may be. */
export function marksOfWhole(whole: Whole, marks: AttributePath[]): AttributePath[] {
  if (whole.sensitive) return [[]];

  return whole.maybe ? fewest([...marks, [MAYBE]]) : marks;
}

/** Sensitive as a whole where `from` is, or may be as a whole where `from` may be. */
export function wholeAs(from: Value, result: Value): Value {
  return wholeWhere(result, isAllSensitive(from), mayBeAllSensitive(from));
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

/** The marks of an item the plan cannot name: those every item has, for certain, and those any one item has, as ones it may have. */
export function anyItemMarks(marks: readonly AttributePath[]): AttributePath[] {
  const named = marks.filter(([first]) => first !== undefined && !isMarker(first)).map((path) => maybeOf(path.slice(1)));

  return fewest([...sensitiveUnder(marks, EVERY_ITEM), ...named]);
}

/** The items of `collection`; one not known yet stands for all of its items, with the marks any of them may have. */
export function itemsOf(collection: Value): Value[] {
  if (collection.data === null) return [];
  if (isUnknown(collection.data)) return [withSensitive(valueOf(types.dynamic, UNKNOWN), anyItemMarks(collection.sensitive ?? []))];

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
