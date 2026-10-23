import { ExactNumber, NumberError } from '@clay/contracts';
import { AttributeValue, ConfigError, isNamed, Position, Step } from '@clay/parser';

import { article, described, hasText, isSensitive, nullSource, Value } from '../Value';

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

/** An index read from a value, and how it is written. */
type IndexStep = { index: AttributeValue; spelled: string };

/** What is wrong with a sensitive number tells what it is, so it is not told. */
function unlessSensitive<T>(index: Value, step: IndexStep, run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (!(error instanceof ConfigError && isSensitive(index))) throw error;
    const named = isNamed(step.index) ? step.spelled : "The value inside '['";
    throw new ConfigError(`${named} is sensitive and is no index: why is not shown`, step.index.position);
  }
}

/** The key a known value comes to as an index: a whole number for a list or a count, a string for a map or a for_each. */
export function keyOf(index: Value, step: IndexStep): Step {
  const { data } = index;
  if (typeof data === 'string') return { key: data };
  if (!(data instanceof ExactNumber)) throw new ConfigError(`An index is a number or a string, not ${described(index)}${nullSource(index)}`, step.index.position);

  return { key: unlessSensitive(index, step, () => wholeIndex(data, step.index.position)) };
}

/** An index not known yet is refused when its type can never be a number or a string. */
export function checkUnknownIndex(index: Value, step: IndexStep): void {
  if (hasText(index.type) || index.type.kind === 'dynamic') return;

  throw new ConfigError(`An index is a number or a string, not ${article(index.type.kind)}`, step.index.position);
}
