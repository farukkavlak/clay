import { AttributeValue, checkConstant, parseExpression, Statement, VariableBlock } from '@clay/parser';
import { VariableInput } from '@clay/planner';

const ENV_PREFIX = 'CLAY_VAR_';

/** Every `CLAY_VAR_<name>` in `env`, as given; whether the root declares the name is checked when it is read. */
export function envInputs(env: Readonly<Record<string, string | undefined>>): VariableInput[] {
  return Object.entries(env).flatMap(([key, text]) =>
    key.startsWith(ENV_PREFIX) && text !== undefined ? [{ from: 'env' as const, name: key.slice(ENV_PREFIX.length), text }] : []
  );
}

/** Where a value given from outside is placed, as a file would be, so an error in it names the flag or the environment variable. */
export const givenAt = ({ from, name }: Pick<VariableInput, 'from' | 'name'>): string => (from === 'env' ? `${ENV_PREFIX}${name}` : `--var ${name}`);

/** A shell gives text, so a variable that takes a string, a number or a bool, or names no type, reads it as written. */
const PLAIN = new Set(['string', 'number', 'bool']);

function written(input: VariableInput, variable: VariableBlock): AttributeValue {
  const file = givenAt(input);
  if (!variable.valueType || PLAIN.has(variable.valueType.kind)) return { type: 'String', value: input.text, position: { file, line: 1, column: 1 } };

  const value = parseExpression(input.text, file);
  checkConstant(value, `A value given with ${input.from === 'env' ? file : '--var'}`);
  return value;
}

/** The last value for each name, so one place names the value an error is in. */
function lastOfEach(inputs: readonly VariableInput[]): VariableInput[] {
  return [...new Map(inputs.map((input) => [input.name, input])).values()];
}

function variablesOf(program: Statement[]): Map<string, VariableBlock> {
  return new Map(program.flatMap((stmt) => (stmt.type === 'Variable' ? [[stmt.name, stmt] as const] : [])));
}

/** The environment may hold values for other configurations, so one for a name the root does not declare is not read. */
export function inputsFor(program: Statement[], inputs: readonly VariableInput[]): VariableInput[] {
  const declared = variablesOf(program);
  return inputs.filter((input) => input.from !== 'env' || declared.has(input.name));
}

/** A later value for a name replaces an earlier one, which is then never read. */
function givenValues(inputs: readonly VariableInput[], program: Statement[]): Map<string, AttributeValue> {
  const declared = variablesOf(program);
  const values = new Map<string, AttributeValue>();

  for (const input of lastOfEach(inputsFor(program, inputs))) {
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
