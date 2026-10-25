import type { AttributePath } from './AttributePath';

/** Stands where a sensitive value would be printed or quoted. */
export const SENSITIVE = '(sensitive value)';

/** The step to every item of a collection not known yet, which has no items to name. No list has an item -1. */
export const EVERY_ITEM = -1;

/** The last step of a path to a value sensitive in some part the plan cannot name yet. No list has an item -2. */
export const SOMEWHERE = -2;

/** The last step of a path to a part sensitive in some outcome, which the plan does not know to be so in every one. No list has an item -3. */
export const MAYBE = -3;

/**
 * The last step of a path to a key or place held for certain that no item the plan cannot name may take, so a mark that the part may be
 * sensitive under every item does not reach it. No list has an item -4.
 */
export const EXACT = -4;

/** EVERY_ITEM, SOMEWHERE, MAYBE or EXACT: no key or index, though a key may be spelled "-1" to "-4". */
export function isMarker(step: string | number): boolean {
  return step === EVERY_ITEM || step === SOMEWHERE || step === MAYBE || step === EXACT;
}

/** A path that says only that the part may be sensitive. */
export function isMaybe(path: AttributePath): boolean {
  return path.at(-1) === MAYBE;
}

/** A path that marks nothing itself, and only keeps from a key or place the marks that may be so under every item. */
export function isExact(path: AttributePath): boolean {
  return path.at(-1) === EXACT;
}

/** Whether `path` says its first step is there for certain: a mark for certain, or the step held exactly, not a key or place below it. */
export function holdsFirst(path: AttributePath): boolean {
  return path[0] !== undefined && !isMarker(path[0]) && !isMaybe(path) && (!isExact(path) || path.length === 2);
}

/** The marks themselves, without the paths that only say a key or place is exact. */
export function marksOnly(paths: readonly AttributePath[]): AttributePath[] {
  return paths.filter((path) => !isExact(path));
}

function sameStep(marked: string | number, step: string | number): boolean {
  return marked === EVERY_ITEM || (!isMarker(marked) && String(marked) === String(step));
}

/** Whether `paths` say the key or place at `step` is exact. */
export function exactAt(paths: readonly AttributePath[], step: string | number): boolean {
  return !isMarker(step) && paths.some((path) => path.length === 2 && isExact(path) && !isMarker(path[0]) && String(path[0]) === String(step));
}

/** Whether a mark at the first step of `path` reaches `step`: a mark that may be so under every item does not reach an exact one. */
function reachesStep(path: AttributePath, step: string | number, exact: boolean): boolean {
  return sameStep(path[0], step) && !(exact && path[0] === EVERY_ITEM && isMaybe(path));
}

/**
 * What is left of each path after `step`. A value sensitive as a whole is so in every part.
 * One that may be so as a whole may be in every part.
 */
export function sensitiveUnder(paths: readonly AttributePath[], step: string | number): AttributePath[] {
  if (paths.some((path) => path.length === 0)) return [[]];

  const exact = exactAt(paths, step);
  const below = paths.filter((path) => reachesStep(path, step, exact) && !(path.length === 2 && isExact(path))).map((path) => path.slice(1));
  return paths.some((path) => path.length === 1 && path[0] === MAYBE) ? [...below, [MAYBE]] : below;
}

/** Whether the value at `at` is sensitive, or may be, in some part, or sits inside a part that is. */
export function touchesSensitive(paths: readonly AttributePath[], at: AttributePath): boolean {
  const [step, ...rest] = at;
  if (step === undefined) return marksOnly(paths).length > 0;
  if (paths.some((path) => path.length === 0 || (path.length === 1 && path[0] === MAYBE))) return true;

  return touchesSensitive(sensitiveUnder(paths, step), rest);
}
