import type { AttributePath } from './AttributePath';
import { isExact, isMarker, isMaybe, MAYBE } from './markers';
import { Marks } from './marks';

/** Stands where a sensitive value would be printed or quoted. */
export const SENSITIVE = '(sensitive value)';

/** Whether `path` says its first step is there for certain: a mark for certain, or the step held exactly, not a key or place below it. */
export function holdsFirst(path: AttributePath): boolean {
  return path[0] !== undefined && !isMarker(path[0]) && !isMaybe(path) && (!isExact(path) || path.length === 2);
}

/** The marks themselves, without the paths that only say a key or place is exact. */
export function marksOnly(paths: readonly AttributePath[]): AttributePath[] {
  return paths.filter((path) => !isExact(path));
}

/** Whether `paths` say the key or place at `step` is exact. */
export function exactAt(paths: readonly AttributePath[], step: string | number): boolean {
  return !isMarker(step) && paths.some((path) => path.length === 2 && isExact(path) && !isMarker(path[0]) && String(path[0]) === String(step));
}

/**
 * What is left of each path after `step`. A value sensitive as a whole is so in every part.
 * One that may be so as a whole may be in every part.
 */
export function sensitiveUnder(paths: readonly AttributePath[], step: string | number): AttributePath[] {
  return Marks.of(paths).under(step).paths();
}

/** Whether the value at `at` is sensitive, or may be, in some part, or sits inside a part that is. */
export function touchesSensitive(paths: readonly AttributePath[], at: AttributePath): boolean {
  const [step, ...rest] = at;
  if (step === undefined) return marksOnly(paths).length > 0;
  if (paths.some((path) => path.length === 0 || (path.length === 1 && path[0] === MAYBE))) return true;

  return touchesSensitive(sensitiveUnder(paths, step), rest);
}
