import { ExactNumber, isUnknown } from '@clay/contracts';

import { described, Value } from './Value';

/** Must be a known whole number. */
export function countFrom(value: Value): number {
  if (isUnknown(value.data)) throw new Error('count must be known when planning: it reads a value only an apply makes');
  if (!(value.data instanceof ExactNumber)) throw new Error(`count is a whole number from 0, not ${described(value)}`);

  const count = value.data.toSafeInteger('count');
  if (count < 0) throw new Error(`count is a whole number from 0, not ${count}`);

  return count;
}

export function indexesOf(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index);
}
