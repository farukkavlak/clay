import type { AttributePath } from './AttributePath';

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
