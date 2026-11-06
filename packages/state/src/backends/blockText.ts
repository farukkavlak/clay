import { AttributeValue, BackendBlock, ConfigError } from '@clay/parser';

/** Refuses an attribute the block's type does not take, at its value. */
export function checkNames({ backendType, attributes }: BackendBlock, takes: readonly string[]): void {
  for (const [name, value] of Object.entries(attributes))
    if (!takes.includes(name)) throw new ConfigError(`backend "${backendType.value}" takes only ${takes.map((known) => `"${known}"`).join(', ')}, not "${name}"`, value.position);
}

export interface Text {
  readonly value: string;
  readonly at: AttributeValue;
}

/** A string written out, since the state has to be found before anything has a value. */
export function textOf({ backendType, attributes }: BackendBlock, name: string): Text | undefined {
  const at = attributes[name];
  if (at === undefined) return undefined;

  const of = `${name} of backend "${backendType.value}"`;
  if (at.type !== 'String') throw new ConfigError(`${of} is a string written out`, at.position);
  if (at.value === '') throw new ConfigError(`${of} must not be empty`, at.position);

  return { value: at.value, at };
}
