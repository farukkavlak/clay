import { ExactNumber, isUnknown } from '@clay/contracts';

import { described, Value } from './Value';

/** A count says how many instances to make, so it is a whole number, and one the plan knows. */
export function countFrom(value: Value): number {
  if (isUnknown(value.data)) throw new Error('count must be known when planning: it reads a value only an apply makes');
  if (!(value.data instanceof ExactNumber)) throw new Error(`count is a whole number from 0, not ${described(value)}`);

  const count = value.data.toSafeInteger('count');
  if (count < 0) throw new Error(`count is a whole number from 0, not ${count}`);

  return count;
}

/** The indexes a count makes: 0 up to one short of it. */
export function indexesOf(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index);
}
