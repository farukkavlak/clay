import { AttributeValue, checkConstant, parseExpression, Statement, VariableBlock } from '@clay/parser';
import { VariableInput } from '@clay/planner';

/** Where a value given with `--var` is placed, as a file would be, so an error in it names the flag. */
export const givenAt = (name: string): string => `--var ${name}`;

/** A shell gives text, so a variable that takes a string, a number or a bool, or names no type, reads it as written. */
const PLAIN = new Set(['string', 'number', 'bool']);

function written({ name, text }: VariableInput, variable: VariableBlock): AttributeValue {
  const file = givenAt(name);
  if (!variable.valueType || PLAIN.has(variable.valueType.kind)) return { type: 'String', value: text, position: { file, line: 1, column: 1 } };

  const value = parseExpression(text, file);
  checkConstant(value, 'A value given with --var');
  return value;
}

/** The last value for each name, so one place names the value an error is in. */
function lastOfEach(inputs: readonly VariableInput[]): VariableInput[] {
  return [...new Map(inputs.map((input) => [input.name, input])).values()];
}

/** A later value for a name replaces an earlier one, which is then never read. */
function givenValues(inputs: readonly VariableInput[], program: Statement[]): Map<string, AttributeValue> {
  const declared = new Map(program.flatMap((stmt) => (stmt.type === 'Variable' ? [[stmt.name, stmt] as const] : [])));
  const values = new Map<string, AttributeValue>();

  for (const input of lastOfEach(inputs)) {
    const variable = declared.get(input.name);
    if (!variable) throw new Error(`--var gives a value to "${input.name}", which the root module does not declare as a variable`);

    values.set(input.name, written(input, variable));
  }
  return values;
}

/** A value given from outside stands where the default is written, so everything that reads the variable reads it. */
export function withGiven(program: Statement[], inputs: readonly VariableInput[]): Statement[] {
  const given = givenValues(inputs, program);
  if (given.size === 0) return program;

  return program.map((stmt) => {
    const value = stmt.type === 'Variable' ? given.get(stmt.name) : undefined;
    return stmt.type === 'Variable' && value ? { ...stmt, attributes: { ...stmt.attributes, default: value } } : stmt;
  });
}
