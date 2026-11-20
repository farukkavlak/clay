import { AttributePath, ExactNumber } from '@clay/provider';

function isAttributePath(path: unknown): path is AttributePath {
  return Array.isArray(path) && path.every((step) => typeof step === 'string' || Number.isInteger(step));
}

export function isAttributePaths(paths: unknown): paths is AttributePath[] {
  return Array.isArray(paths) && paths.every((path) => isAttributePath(path));
}

/** An index in a path read from a file is a plain number, where every other number read from one is exact. */
export function readPaths(paths: unknown, what: string): unknown {
  if (!Array.isArray(paths)) return paths;

  return paths.map((path: unknown) => (Array.isArray(path) ? path.map((step: unknown) => (step instanceof ExactNumber ? step.toSafeInteger(what) : step)) : path));
}
