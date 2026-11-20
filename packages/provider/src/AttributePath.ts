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

/** The order follows how the configuration is written, so it says nothing. */
export function samePaths(one: readonly AttributePath[], other: readonly AttributePath[]): boolean {
  const spelled = (paths: readonly AttributePath[]) => new Set(paths.map((path) => JSON.stringify(path)));
  const [left, right] = [spelled(one), spelled(other)];

  return left.size === right.size && [...left].every((path) => right.has(path));
}
