import { isUnknown, Output } from '@clay/contracts';
import { isDeepStrictEqual } from 'node:util';

import { Changes, OutputChanges, Plan } from './Plan';

/** Map key order is not a change. */
function valueChanged(oldValue: unknown, newValue: unknown): boolean {
  if (isUnknown(newValue)) return true;
  return !isDeepStrictEqual(oldValue, newValue);
}

/** Maps, so an inherited name like `toString` is absent and `__proto__` is an ordinary key. */
export function calculateDiff<T>(oldAttrs: Record<string, T>, newAttrs: Record<string, T>): Record<string, { old: T | undefined; new: T | undefined }> | null {
  const before = new Map(Object.entries(oldAttrs));
  const after = new Map(Object.entries(newAttrs));
  const changes = new Map<string, { old: T | undefined; new: T | undefined }>();

  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const oldValue = before.get(key);
    const newValue = after.get(key);

    if (valueChanged(oldValue, newValue)) changes.set(key, { old: oldValue, new: newValue });
  }

  return changes.size > 0 ? Object.fromEntries(changes) : null;
}

/** A type change is a change: a set and a list with the same members differ. */
export function outputChanges(current: Record<string, Output>, desired: Record<string, Output>): OutputChanges {
  return calculateDiff(current, desired) ?? {};
}

/** A resource changed outside Clay; without `changes` it was deleted. */
export interface Drift {
  address: string;
  changes?: Changes;
}

/** Drift found by refresh: where `prior` differs from `prevRun`. */
export function changedOutside(plan: Plan): Drift[] {
  return Object.entries(plan.prevRun).flatMap(([address, held]) => {
    if (!Object.hasOwn(plan.prior, address)) return [{ address }];

    const changes = calculateDiff(held.attributes, plan.prior[address].attributes);
    return changes ? [{ address, changes }] : [];
  });
}

export function hasChanges(currentAttrs: Record<string, unknown>, after: Record<string, unknown>): boolean {
  return calculateDiff(currentAttrs, after) !== null;
}
