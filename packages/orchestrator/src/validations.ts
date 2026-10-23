import { containsUnknown, ModuleAddress, State } from '@clay/contracts';
import { AttributeValue, ConfigError, Validation } from '@clay/parser';

import { checkBoolean } from './operators';
import { tryAt } from './place';
import { unknownOf, UnresolvedReferenceError } from './resolvers/UnresolvedReferenceError';
import { VariableValue } from './scope/ScopeManager';
import { described, isSensitive, Value } from './Value';

export interface RuleReader {
  resolveWithVariable: (value: AttributeValue, state: State, context: ModuleAddress, name: string, given: Value) => Value;
}

/** Refused where the value is given, as a type that does not fit is. */
export class ValidationFailed extends Error {
  override name = 'ValidationFailed';
}

/** A part of the value not known until the apply reads as unknown, so the rule waits for it. */
function readOrUnknown(read: () => Value): Value {
  try {
    return read();
  } catch (error) {
    if (!(error instanceof UnresolvedReferenceError)) throw error;
    return unknownOf(error);
  }
}

const notAString = (message: Value, node: AttributeValue) => new ConfigError(`A validation's error_message is a string, not ${described(message)}`, node.position);

function messageOf(message: Value, node: AttributeValue): string {
  if (containsUnknown(message.data)) throw new ConfigError("A validation's error_message is not known until the apply", node.position);
  if (message.data === null || message.type.kind !== 'string') throw notAString(message, node);
  if (isSensitive(message)) return 'the error_message holds a sensitive value, so it is not shown';

  return (message.data as string).trim();
}

/**
 * Each rule is read in the module instance that declares the variable, with the variable's value, and a mistake in one is placed there.
 * A condition not known until the apply waits for it.
 */
export function validate(name: string, { validations }: VariableValue, value: Value, { module, state, reader }: { module: ModuleAddress; state: State; reader: RuleReader }): void {
  if (!validations) return;

  const { rules, declaration } = validations;
  const inRule = <T>(node: AttributeValue, work: (read: Value) => T): T =>
    tryAt(node.position, declaration, module, () => work(readOrUnknown(() => reader.resolveWithVariable(node, state, module, name, value))));

  for (const { condition, errorMessage } of rules) {
    const met = inRule(condition, (read) => {
      checkBoolean("A validation's condition", read, condition.position);
      return read.data;
    });
    if (met !== false) continue;

    throw new ValidationFailed(`variable "${name}": ${inRule(errorMessage, (read) => messageOf(read, errorMessage))}`);
  }
}

/** Read as written, before any instance: a condition that can be no boolean, or a message that can be no string, is refused. */
export function checkWritten({ condition, errorMessage }: Validation, read: (node: AttributeValue) => Value): void {
  checkBoolean("A validation's condition", read(condition), condition.position);

  const message = read(errorMessage);
  if (message.type.kind !== 'string' && message.type.kind !== 'dynamic') throw notAString(message, errorMessage);
  if (!containsUnknown(message.data)) messageOf(message, errorMessage);
}
