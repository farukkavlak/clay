import { AttributeValue, checkConstant, ConfigError, parseExpression, parseValues, Statement, VariableBlock } from '@clay/parser';
import { NamedInput, VariableInput } from '@clay/planner';

const ENV_PREFIX = 'CLAY_VAR_';

/** Every `CLAY_VAR_<name>` in `env`, as given; whether the root declares the name is checked when it is read. */
export function envInputs(env: Readonly<Record<string, string | undefined>>): VariableInput[] {
  return Object.entries(env).flatMap(([key, text]) =>
    key.startsWith(ENV_PREFIX) && text !== undefined ? [{ from: 'env' as const, name: key.slice(ENV_PREFIX.length), text }] : []
  );
}

/** Where a value given from outside is placed, as a file would be, so an error in it names the flag, the environment variable or the file. */
export function givenAt(input: VariableInput): string {
  if (input.from === 'file') return input.file;
  return input.from === 'env' ? `${ENV_PREFIX}${input.name}` : `--var ${input.name}`;
}

/** A shell gives text, so a variable that takes a string, a number or a bool, or names no type, reads it as written. */
const PLAIN = new Set(['string', 'number', 'bool']);

function written(input: NamedInput, variable: VariableBlock): AttributeValue {
  const file = givenAt(input);
  if (!variable.valueType || PLAIN.has(variable.valueType.kind)) return { type: 'String', value: input.text, position: { file, line: 1, column: 1 } };

  const value = parseExpression(input.text, file);
  checkConstant(value, `A value given with ${input.from === 'env' ? file : '--var'}`);
  return value;
}

/** One value for a name, read only if no later one replaces it. */
interface Given {
  name: string;
  read: () => AttributeValue;
}

function variablesOf(program: Statement[]): Map<string, VariableBlock> {
  return new Map(program.flatMap((stmt) => (stmt.type === 'Variable' ? [[stmt.name, stmt] as const] : [])));
}

/** A file is read whole, so a mistake in it is refused even where a later value replaces the line it is on. */
function fromFile(file: string, text: string, declared: Map<string, VariableBlock>): Given[] {
  return parseValues(text, file).map(({ name, value, position }) => {
    if (!declared.has(name)) throw new ConfigError(`"${name}" is given a value, but the root module does not declare it as a variable`, position);

    checkConstant(value, 'A value in a variables file');
    return { name, read: () => value };
  });
}

function fromInput(input: VariableInput, declared: Map<string, VariableBlock>): Given[] {
  if (input.from === 'file') return fromFile(input.file, input.text, declared);

  const variable = declared.get(input.name);
  if (!variable) throw new Error(`--var gives a value to "${input.name}", which the root module does not declare as a variable`);
  return [{ name: input.name, read: () => written(input, variable) }];
}

/** The environment may hold values for other configurations, so one for a name the root does not declare is not read. */
export function inputsFor(program: Statement[], inputs: readonly VariableInput[]): VariableInput[] {
  const declared = variablesOf(program);
  return inputs.filter((input) => input.from !== 'env' || declared.has(input.name));
}

/** A later value for a name replaces an earlier one, which is then never read. */
function givenValues(inputs: readonly VariableInput[], program: Statement[]): Map<string, AttributeValue> {
  const declared = variablesOf(program);
  const given = inputsFor(program, inputs).flatMap((input) => fromInput(input, declared));
  const last = new Map(given.map(({ name, read }) => [name, read]));

  return new Map([...last].map(([name, read]) => [name, read()]));
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
