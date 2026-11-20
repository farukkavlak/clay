import type { AttributePath } from './AttributePath';
import { isRecord } from './isRecord';

/** A value known only after apply. A symbol, so no value from a configuration or a file can pass for it. */
export const UNKNOWN: unique symbol = Symbol('unknown');

export function isUnknown(value: unknown): boolean {
  return value === UNKNOWN;
}

/** Searches nested values: a plan may know a map but not one of its values. */
export function containsUnknown(value: unknown): boolean {
  if (isUnknown(value)) return true;
  if (Array.isArray(value)) return value.some((item) => containsUnknown(item));

  return isRecord(value) && Object.values(value).some((item) => containsUnknown(item));
}

/** `[[]]` when the whole value is unknown. */
export function unknownPaths(value: unknown, at: AttributePath = []): AttributePath[] {
  if (isUnknown(value)) return [at];
  if (Array.isArray(value)) return value.flatMap((item, index) => unknownPaths(item, [...at, index]));

  return isRecord(value) ? Object.entries(value).flatMap(([key, item]) => unknownPaths(item, [...at, key])) : [];
}
