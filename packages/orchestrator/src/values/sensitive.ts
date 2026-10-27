import {
  AttributePath,
  EVERY_ITEM,
  EXACT,
  exactAt,
  isExact,
  isMarker,
  isMaybe,
  isRecord,
  isUnknown,
  MAYBE,
  marksOnly,
  own,
  sensitiveUnder,
  SOMEWHERE,
  Type,
  typeAt,
  types,
  UNKNOWN,
} from '@clay/contracts';

import { PathTree } from './PathTree';
import { everyItemPlaces, Pattern, Patterns } from './Patterns';
import { Value, valueOf, withSensitive, allSensitive, isAllSensitive, mayBeSensitive, child, sensitiveOf } from './Value';

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
  return values.every((value) => holds(value.data, value.type, sensitiveOf(value), path, oneItem));
}

/** In any part, for certain: a mark under every item of a collection not known yet, which may come out empty, marks nothing for certain. */
export function isSensitive(value: Value): boolean {
  return marksOnly(sensitiveOf(value)).some((path) => allHold([value], path, true));
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

/** Whether `exacts` say the step at `index` of `within` is exact, which a mark that may be so under every item does not reach. */
function exactStep(exacts: Patterns, within: AttributePath, index: number): boolean {
  return named(within[index]) && exacts.has(within.slice(0, index), String(within[index]));
}

/** Whether a mark at `path`, of either kind, means every part at `within` may be sensitive. Under every item, the item may be. */
function coversMaybe(path: AttributePath, within: AttributePath, exacts: Patterns): boolean {
  const marked = isMaybe(path) ? path.slice(0, -1) : path;
  const everyItem = (index: number) => !(isMaybe(path) && exactStep(exacts, within, index));

  return marked.length <= within.length && marked.every((step, index) => (step === EVERY_ITEM ? everyItem(index) : reaches(step, within[index])));
}

/**
 * The marks that may cover `at`: those along its steps, and, where it may be sensitive, those that may be so along them or under every item.
 * Where it is sensitive somewhere, those inside it too.
 */
function coverers(marks: PathTree, at: AttributePath): AttributePath[] {
  if (isMaybe(at))
    return marks
      .levels(at.slice(0, -1), true)
      .flat()
      .flatMap((node) => [...node.paths, ...(node.child(MAYBE)?.paths ?? [])]);

  const somewhere = at.at(-1) === SOMEWHERE;
  const levels = marks.levels(somewhere ? at.slice(0, -1) : at, false);
  const inside = somewhere ? (levels.at(-1) ?? []).flatMap((node) => [...node.all()]) : [];
  return [...levels.flat().flatMap((node) => node.paths), ...inside];
}

/**
 * Whether `marks` mark all of what is at `at`: a path to it, or to what holds it.
 * Where `at` is sensitive somewhere, a mark inside it covers it only if it is there for certain, so not one under every item.
 * Where `at` may be sensitive, any mark that may be so at or above it covers it, and none for certain is covered by one that may be.
 */
function covers(marks: PathTree, at: AttributePath, exacts: Patterns): boolean {
  const paths = coverers(marks, at).filter((path) => path !== at);
  if (isMaybe(at)) return paths.some((path) => coversMaybe(path, at.slice(0, -1), exacts));

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

/** The steps before each step every item of a mark that may be so, which may reach an exact key or place after as many steps. */
function beforeEveryItem(path: AttributePath): Pattern[] {
  return everyItemPlaces(path).map((at) => [path.slice(0, at), '']);
}

/** Whether a mark that may be so under every item beside the exact key or place at `exact` would reach it, if not for that. */
function keepsOut(exact: AttributePath, maybes: Patterns): boolean {
  return exact.length >= 2 && maybes.has(exact.slice(0, -2), '');
}

/** Each once, none that another already covers, and no exact key or place that keeps nothing out. */
export function fewest(paths: AttributePath[]): AttributePath[] {
  const unique = new Map<string, AttributePath>();
  for (const path of paths) {
    const key = JSON.stringify(path.map((step) => (isMarker(step) ? step : String(step))));
    if (!unique.has(key)) unique.set(key, path);
  }
  const maybes = new Patterns([...unique.values()].filter((path) => isMaybe(path)).flatMap((path) => beforeEveryItem(path)));
  const once = [...unique.values()].filter((path) => !isExact(path) || keepsOut(path, maybes));

  const exacts = new Patterns(once.filter((path) => isExact(path) && path.length >= 2).map((path): Pattern => [path.slice(0, -2), String(path.at(-2))]));
  const marks = new PathTree(marksOnly(once));
  return once.filter((path) => !covers(marks, path, exacts));
}

/** What both sets of marks mark: those of `lefts`, shared so far, and those of `right`. */
function meets(marks: AttributePath[], lefts: Value[], right: Value): AttributePath[] {
  return marks.flatMap((mark) =>
    sensitiveOf(right)
      .map((path) => meet(mark, path, [lefts, [right]]))
      .filter((met): met is AttributePath => met !== undefined)
  );
}

/** The marks every one of `values` has, for certain. */
function certainShared(values: Value[]): AttributePath[] {
  const certain = values.map((value) =>
    withSensitive(
      value,
      marksOnly(sensitiveOf(value)).filter((path) => !isMaybe(path))
    )
  );
  const [first, ...rest] = certain;
  if (first === undefined) return [];

  return rest.reduce((marks, value, index) => meets(marks, certain.slice(0, index + 1), value), [...sensitiveOf(first)]);
}

/** The marks any of `values` has, each as one it may have. */
function maybeOfEach(values: Value[]): AttributePath[] {
  return values.flatMap((value) =>
    marksOnly(sensitiveOf(value))
      .filter((path) => path.at(-1) !== SOMEWHERE)
      .map((path) => maybeOf(path))
  );
}

/** The first step of each path to an exact key or place, at any depth. */
function exactSteps(values: Value[]): (string | number)[] {
  const steps = values.flatMap((value) =>
    sensitiveOf(value)
      .filter((path) => path.length > 1 && isExact(path))
      .map(([step]) => step)
  );

  return [...new Set(steps)];
}

/** What is at `step` of a value not known yet. */
function partLater(value: Value, step: string | number): Value {
  return withSensitive(valueOf(typeAt(value.type, step), UNKNOWN), sensitiveUnder(sensitiveOf(value), step));
}

/** A known collection holds its keys and places itself, so no item the plan cannot name may take one. */
function heldKnown({ data }: Value, step: string | number): boolean {
  return Array.isArray(data) ? typeof step === 'number' && step >= 0 && step < data.length : isRecord(data) && Object.hasOwn(data, String(step));
}

/** What is at `step`, read from a known collection where it holds it. */
function partAt(value: Value, step: string | number): Value {
  return heldKnown(value, step) ? child(value, step) : partLater(value, step);
}

/** What may be there: `values`, those of them to take the marks they may have from, and `others` that may be there too. */
interface Among {
  values: Value[];
  maybeFrom: Value[];
  others: Value[];
}

/**
 * The marks every one of `values` has, where `certain`, and those any of `maybeFrom` has as ones it may have.
 * A key or place every one of `values`, and of `others`, holds exactly stays so at any depth, with the marks the parts of `values` have there,
 * since no mark that may be so under every item reaches it. Below a step some value may not hold exactly, only the marks they may have.
 */
function marksAmong(among: Among, certain: boolean): AttributePath[] {
  const exact = exactSteps(among.values).flatMap((step) => {
    const parts = (from: Value[]) => from.map((value) => partAt(value, step));
    const inner: Among = { values: parts(among.values), maybeFrom: parts(among.maybeFrom), others: parts(among.others) };
    const here = [...among.values, ...among.others].every((value) => exactAt(sensitiveOf(value), step) || heldKnown(value, step));

    return [...(here ? [[step, EXACT]] : []), ...marksAmong(inner, certain && here).map((path) => [step, ...path])];
  });

  return fewest([...(certain ? certainShared(among.values) : []), ...maybeOfEach(among.maybeFrom), ...exact]);
}

/** The marks any of `values` has, each as one it may have, and the keys and places all of them, and all of `others` that may be there instead, hold exactly. */
export function maybeMarks(values: Value[], others: Value[] = []): AttributePath[] {
  return marksAmong({ values, maybeFrom: values, others }, false);
}

/** The marks every one of `values` has, so a value that is one of them, not known which, has them for certain, and those any has as ones it may have. */
export function sharedMarks(values: Value[]): AttributePath[] {
  return marksAmong({ values, maybeFrom: values, others: [] }, true);
}

/**
 * The marks of each item of what is not known yet, where each may be any of `values`.
 * Only the `unnamed` ones may be at a key or place no mark names, so only theirs may be there.
 */
export function everyItemMarks(values: Value[], unnamed = values): AttributePath[] {
  return marksAmong({ values, maybeFrom: unnamed, others: [] }, true).map((path) => [EVERY_ITEM, ...path]);
}

/** As a whole, in some outcome. */
export function mayBeAllSensitive(value: Value): boolean {
  return isAllSensitive(value) || sensitiveOf(value).some((path) => path.length === 1 && path[0] === MAYBE);
}

/** Sensitive as a whole where `sensitive`; else, where `maybe`, it may be as a whole beside the marks it has. */
export function wholeWhere(result: Value, sensitive: boolean, maybe: boolean): Value {
  if (sensitive) return allSensitive(result);

  return maybe ? withSensitive(result, fewest([...sensitiveOf(result), [MAYBE]])) : result;
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

/** The marks of an item the plan cannot name: those every item has, for certain, and those any one item has, as ones it may have. */
export function anyItemMarks(marks: readonly AttributePath[]): AttributePath[] {
  const named = marksOnly(marks)
    .filter(([first]) => first !== undefined && !isMarker(first))
    .map((path) => maybeOf(path.slice(1)));

  return fewest([...sensitiveUnder(marks, EVERY_ITEM), ...named]);
}

/** The items of `collection`; one not known yet stands for all of its items, with the marks any of them may have. */
export function itemsOf(collection: Value): Value[] {
  if (collection.data === null) return [];
  if (isUnknown(collection.data)) return [withSensitive(valueOf(types.dynamic, UNKNOWN), anyItemMarks(sensitiveOf(collection)))];

  const steps = Array.isArray(collection.data) ? collection.data.map((_, index) => index) : Object.keys(collection.data as Record<string, unknown>);
  return steps.map((step) => child(collection, step));
}
