import { AttributePath, EVERY_ITEM, exactAt, isExact, isMarker, isMaybe, MAYBE } from '../src';

// sensitiveUnder as it was before marks were held by their steps, so the tree can be held against it.
function sameStep(marked: string | number, step: string | number): boolean {
  return marked === EVERY_ITEM || (!isMarker(marked) && String(marked) === String(step));
}

/** Whether a mark at the first step of `path` reaches `step`: a mark that may be so under every item does not reach an exact one. */
function reachesStep(path: AttributePath, step: string | number, exact: boolean): boolean {
  return sameStep(path[0], step) && !(exact && path[0] === EVERY_ITEM && isMaybe(path));
}

/** What is left of each path after `step`, read by going over every path. */
export function sensitiveUnderAsWas(paths: readonly AttributePath[], step: string | number): AttributePath[] {
  if (paths.some((path) => path.length === 0)) return [[]];

  const exact = exactAt(paths, step);
  const below = paths.filter((path) => reachesStep(path, step, exact) && !(path.length === 2 && isExact(path))).map((path) => path.slice(1));
  return paths.some((path) => path.length === 1 && path[0] === MAYBE) ? [...below, [MAYBE]] : below;
}
