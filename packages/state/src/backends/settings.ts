import { BackendBlock, ConfigError } from '@clay/parser';

/** What a backend is built from: the block in the configuration, or the record `init` wrote. Both are checked the same way. */
export interface Settings {
  readonly type: string;
  readonly names: readonly string[];
  /** Undefined where none is given. */
  text(name: string): string | undefined;
  /** Refuses the value of `name`, or the backend as a whole. */
  refuse(problem: string, name?: string): never;
}

/** A string written out, since the state has to be found before anything has a value. */
function textOf({ backendType, attributes }: BackendBlock, name: string): string | undefined {
  const at = attributes[name];
  if (at === undefined) return undefined;

  const of = `${name} of backend "${backendType.value}"`;
  if (at.type !== 'String') throw new ConfigError(`${of} is a string written out`, at.position);
  if (at.value === '') throw new ConfigError(`${of} must not be empty`, at.position);

  return at.value;
}

export function blockSettings(block: BackendBlock): Settings {
  return {
    type: block.backendType.value,
    names: Object.keys(block.attributes),
    text: (name) => textOf(block, name),
    refuse: (problem, name) => {
      throw new ConfigError(problem, (name === undefined ? undefined : block.attributes[name])?.position ?? block.backendType.position);
    },
  };
}

export const unwritten = (record: string) => new Error(`${record} is not what \`clay init\` writes; remove it and run \`clay init\``);

/** A record that does not build a backend was not written by `init`, whatever is wrong with it. */
export function recordSettings(type: string, values: Readonly<Record<string, unknown>>, record: string): Settings {
  const refuse = (): never => {
    throw unwritten(record);
  };
  const textIn = (value: unknown): string => (typeof value === 'string' && value !== '' ? value : refuse());

  return {
    type,
    names: Object.keys(values),
    text: (name) => (Object.hasOwn(values, name) ? textIn(values[name]) : undefined),
    refuse,
  };
}

/** Refuses a setting the backend does not take. */
export function checkNames(settings: Settings, takes: readonly string[]): void {
  for (const name of settings.names)
    if (!takes.includes(name)) settings.refuse(`backend "${settings.type}" takes only ${takes.map((known) => `"${known}"`).join(', ')}, not "${name}"`, name);
}
