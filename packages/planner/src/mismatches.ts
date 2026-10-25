import { AttributePath, containsUnknown, isRecord, isUnknown, own, Schema, Type, typeAt, typeIn, UNKNOWN, unknownPaths, valueAt } from '@clay/contracts';
import { isDeepStrictEqual } from 'node:util';

export interface Mismatch {
  path: AttributePath;
  planned: unknown;
  returned: unknown;
}

function includes(members: unknown[], member: unknown): boolean {
  return members.some((other) => isDeepStrictEqual(other, member));
}

/**
 * Sets have no positions. The set must hold every known planned member, plus at most one extra member per planned unknown,
 * since an unknown may become a new member or one the set already has.
 */
function setMismatches(planned: unknown[], actual: unknown, at: AttributePath): Mismatch[] {
  if (!Array.isArray(actual)) return [{ path: at, planned, returned: actual }];

  const known = planned.filter((member) => !containsUnknown(member));
  const others = actual.filter((member) => !includes(known, member));
  const holds = known.every((member) => includes(actual, member)) && others.length <= planned.length - known.length;

  return holds ? [] : [{ path: at, planned, returned: actual }];
}

type Compare = (type: Type, planned: unknown, actual: unknown, at: AttributePath) => Mismatch[];

function itemMismatches(type: Type, planned: unknown[], actual: unknown, at: AttributePath, compare: Compare): Mismatch[] {
  if (!Array.isArray(actual) || planned.length !== actual.length) return [{ path: at, planned, returned: actual }];

  return planned.flatMap((item, i) => compare(typeAt(type, i), item, actual[i], [...at, i]));
}

function entryMismatches(type: Type, planned: Record<string, unknown>, actual: unknown, at: AttributePath, compare: Compare): Mismatch[] {
  if (!isRecord(actual) || !isDeepStrictEqual(Object.keys(planned).sort(), Object.keys(actual).sort())) return [{ path: at, planned, returned: actual }];

  return Object.keys(planned).flatMap((key) => compare(typeAt(type, key), planned[key], actual[key], [...at, key]));
}

/** An unknown may become anything; every known part must match. */
function mismatches(type: Type, planned: unknown, actual: unknown, at: AttributePath): Mismatch[] {
  if (isUnknown(planned)) return [];
  if (type.kind === 'set' && Array.isArray(planned)) return setMismatches(planned, actual, at);
  if (Array.isArray(planned)) return itemMismatches(type, planned, actual, at, mismatches);
  if (isRecord(planned)) return entryMismatches(type, planned, actual, at, mismatches);

  return isDeepStrictEqual(planned, actual) ? [] : [{ path: at, planned, returned: actual }];
}

/** Where the provider's plan at apply differs from the saved plan. An unknown may become anything or stay unknown. */
export function offFinal(schema: Schema, after: Record<string, unknown>, final: Record<string, unknown>): Mismatch[] {
  return [...new Set([...Object.keys(after), ...Object.keys(final)])].flatMap((name) => mismatches(typeIn(schema, name), own(after, name), own(final, name), [name]));
}

/**
 * Where the applied result differs from the plan. A configured value is checked against what it resolved to at apply, which the plan
 * may not have known. The result may hold no unknown.
 */
export function offApply(schema: Schema, after: Record<string, unknown>, inputs: Record<string, unknown>, returned: Record<string, unknown>): Mismatch[] {
  const expected = { ...after, ...inputs };

  return [...new Set([...Object.keys(expected), ...Object.keys(returned)])].flatMap((name) => {
    const unknown = unknownPaths(own(returned, name), [name]);
    if (unknown.length > 0) return unknown.map((path) => ({ path, planned: valueAt(expected, path), returned: UNKNOWN }));

    return mismatches(typeIn(schema, name), own(expected, name), own(returned, name), [name]);
  });
}

/** The first attribute whose value at apply differs from the plan. */
export function offPlan(schema: Schema, planned: Record<string, unknown>, resolved: Record<string, unknown>): { name: string; planned: unknown; resolved: unknown } | undefined {
  for (const name of new Set([...Object.keys(planned), ...Object.keys(resolved)]))
    if (mismatches(typeIn(schema, name), own(planned, name), own(resolved, name), [name]).length > 0) return { name, planned: own(planned, name), resolved: own(resolved, name) };

  return undefined;
}
