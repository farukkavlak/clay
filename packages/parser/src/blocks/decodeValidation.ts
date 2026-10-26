import { AttributeValue, namedIn, Validation } from '../ast';
import { Block } from '../body';
import { ConfigError } from '../ConfigError';
import { ParsedReference, parseReference } from '../reference';
import { attributesOnly } from './attributes';

const readsVariable = (reference: ParsedReference, name: string) => reference.kind === 'variable' && reference.name === name;

/** Checked as it is read. */
export function checkValidationArgument(name: string, value: AttributeValue): void {
  if (name !== 'condition' && name !== 'error_message') throw new ConfigError(`validation takes only "condition" and "error_message", not "${name}".`, value.position);
}

/** A rule on `variable`, which its condition has to read. */
export function decodeValidation(block: Block, variable: string): Validation {
  const read: Record<string, AttributeValue> = {};
  for (const item of attributesOnly(block.body)) read[item.name] = item.value;

  const { condition, error_message: errorMessage } = read;
  if (condition === undefined || errorMessage === undefined) throw new ConfigError(`validation needs ${condition ? 'an error_message' : 'a condition'}`, block.position);
  if (!namedIn(condition).some((named) => named.type === 'Reference' && readsVariable(parseReference(named.value, named.position), variable)))
    throw new ConfigError(`A validation's condition reads var.${variable}, or it checks nothing`, condition.position);

  return { condition, errorMessage, position: block.position };
}
