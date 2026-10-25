import { ExactNumber } from './ExactNumber';
import { isRecord } from './isRecord';

/** The attribute name, then map keys and list indexes. */
export type AttributePath = (string | number)[];

/** Own properties only, so `toString` finds nothing. */
export function own(values: Record<string, unknown>, name: string): unknown {
  return Object.hasOwn(values, name) ? values[name] : undefined;
}

export function valueAt(value: unknown, path: AttributePath): unknown {
  let at = value;

  for (const step of path)
    if (Array.isArray(at) && typeof step === 'number') at = at[step];
    else if (isRecord(at) && typeof step === 'string') at = own(at, step);
    else return undefined;

  return at;
}

function isAttributePath(path: unknown): path is AttributePath {
  return Array.isArray(path) && path.every((step) => typeof step === 'string' || Number.isInteger(step));
}

export function isAttributePaths(paths: unknown): paths is AttributePath[] {
  return Array.isArray(paths) && paths.every((path) => isAttributePath(path));
}

/** The order follows how the configuration is written, so it says nothing. */
export function samePaths(one: readonly AttributePath[], other: readonly AttributePath[]): boolean {
  const spelled = (paths: readonly AttributePath[]) => new Set(paths.map((path) => JSON.stringify(path)));
  const [left, right] = [spelled(one), spelled(other)];

  return left.size === right.size && [...left].every((path) => right.has(path));
}

/** An index in a path read from a file is a plain number, where every other number read from one is exact. */
export function readPaths(paths: unknown, what: string): unknown {
  if (!Array.isArray(paths)) return paths;

  return paths.map((path: unknown) => (Array.isArray(path) ? path.map((step: unknown) => (step instanceof ExactNumber ? step.toSafeInteger(what) : step)) : path));
}
