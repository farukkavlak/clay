import { ExactNumber, isUnknown } from '@clay/contracts';

import { NotKnownYet } from './NotKnownYet';
import { described, isSensitive, Value } from './Value';

function notANumber(value: Value): Error {
  return new Error(`count is a whole number from 0, not ${described(value)}`);
}

/** Must be a known whole number. A value not known yet has its type, so one no apply can make a number is refused first, and so is a sensitive one. */
export function countFrom(value: Value): number {
  const { kind } = value.type;
  if (kind !== 'number' && kind !== 'dynamic') throw notANumber(value);
  if (isSensitive(value)) throw new Error('count is sensitive: the number of instances shows what it is');
  if (isUnknown(value.data)) throw new NotKnownYet('count must be known when planning: it reads a value only an apply makes');
  if (!(value.data instanceof ExactNumber)) throw notANumber(value);

  const count = value.data.toSafeInteger('count');
  if (count < 0) throw new Error(`count is a whole number from 0, not ${count}`);

  return count;
}

export function indexesOf(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index);
}
