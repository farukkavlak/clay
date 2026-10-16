import { ExactNumber, NumberError } from '@clay/contracts';
import { ConfigError, Position, Step } from '@clay/parser';

import { described, isSensitive, Value } from '../Value';

/** The text of an index is never quoted, since a value it was read from may be sensitive. */
function wholeIndex(number: ExactNumber, position: Position): number {
  try {
    const index = number.toSafeInteger();
    if (index < 0) throw new ConfigError('An index is not negative', position);

    return index;
  } catch (error) {
    if (!(error instanceof NumberError)) throw error;
    throw new ConfigError(`An index ${error.problem}`, position);
  }
}

function plainKeyOf(index: Value, position: Position): Step {
  if (typeof index.data === 'string') return { key: index.data };
  if (index.data instanceof ExactNumber) return { key: wholeIndex(index.data, position) };

  throw new ConfigError(`An index is a number or a string, not ${described(index)}`, position);
}

/**
 * The key a known value comes to as an index: a whole number for a list or a count, a string for a map or a for_each.
 * A sensitive value's sign, size and type are parts of it, so what is wrong with it is not told.
 */
export function keyOf(index: Value, spelled: string, position: Position): Step {
  try {
    return plainKeyOf(index, position);
  } catch (error) {
    if (!(error instanceof ConfigError && isSensitive(index))) throw error;
    throw new ConfigError(`${spelled} is sensitive and is no index: why is not shown`, position);
  }
}
