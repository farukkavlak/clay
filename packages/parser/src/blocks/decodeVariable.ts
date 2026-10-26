import { VariableBlock } from '../ast';
import { Block, Label } from '../body';
import { checkConstant } from '../checkConstant';
import { ConfigError } from '../ConfigError';
import { typedBodyOf, TypedRules } from './typedBody';

/** Reserved by a module call, so no module input may use them. */
const CALL_ARGUMENTS = new Set(['count', 'for_each', 'depends_on']);

/** Checked with the label, before the body is read. */
export function checkVariableName({ value, position }: Label): void {
  if (value === 'source') throw new ConfigError('"source" cannot be a variable name: a module call reads it as the module\'s path.', position);
  if (CALL_ARGUMENTS.has(value)) throw new ConfigError(`"${value}" cannot be a variable name: a module call keeps it for itself.`, position);
}

export const variableRules = (name: string): TypedRules => ({ label: `Variable "${name}"`, valueName: 'default', flag: 'sensitive', variable: name });

export function decodeVariable(block: Block, [name]: string[]): VariableBlock {
  const { attributes, declared, flagged, validations } = typedBodyOf(block, variableRules(name));
  // A module input replaces the default, so a reference or a call in it might never be checked.
  if (attributes.default) checkConstant(attributes.default, "A variable's default");

  return {
    type: 'Variable',
    name,
    attributes,
    ...(declared && { valueType: declared.type }),
    ...(declared?.defaults && { defaults: declared.defaults }),
    ...(flagged && { sensitive: true }),
    ...(validations.length > 0 && { validations }),
    position: block.position,
  };
}
