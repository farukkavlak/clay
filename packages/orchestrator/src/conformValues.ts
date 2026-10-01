import { AttributePath, ExactNumber, isRecord, isUnknown, NumberError, Schema, SchemaDefinition, SchemaType } from '@clay/contracts';
import { DataBlock, Position, ResourceBlock } from '@clay/parser';

import { shown } from './shown';
import { spelled } from './spelled';

/** A value the schema does not take, with the attribute it is in, so the caller can say where that was written. One left out is in none. */
export class SchemaMismatch extends Error {
  constructor(
    message: string,
    readonly attribute?: string
  ) {
    super(message);
    this.name = 'SchemaMismatch';
  }
}

/** Where an error in a block's values was written: a mismatch at its value, anything else at the block. */
export function writtenAt(error: unknown, block: ResourceBlock | DataBlock): Position {
  return error instanceof SchemaMismatch && error.attribute !== undefined ? block.attributes[error.attribute].position : block.position;
}

/** What is wrong with the names a resource, or an object in it, sets: `set` is the name when it is one written, so it has a place. */
export interface NameProblem {
  message: string;
  set?: string;
}

/** A name the schema does not have comes first, then one it requires that is left out. */
export function nameProblem(resource: string, schema: Schema, names: string[], within: AttributePath = []): NameProblem | undefined {
  const where = within.length > 0 ? ` in ${spelled(within)}` : '';

  const unnamed = names.find((name) => !Object.hasOwn(schema, name));
  if (unnamed !== undefined) return { message: `${resource} has no attribute "${unnamed}"${where}`, set: unnamed };

  const missing = Object.keys(schema).find((name) => schema[name].required && !names.includes(name));
  return missing === undefined ? undefined : { message: `${resource} requires "${missing}"${where}` };
}

const articles: Record<SchemaType, string> = { string: 'a string', number: 'a number', boolean: 'a boolean', list: 'a list', map: 'a map', object: 'an object' };

function kindOf(value: unknown): string {
  if (value instanceof ExactNumber) return 'a number';
  if (Array.isArray(value)) return 'a list';
  if (isRecord(value)) return 'a map';

  return `a ${typeof value}`;
}

function isType(type: SchemaType, value: unknown): boolean {
  if (type === 'string' || type === 'boolean') return typeof value === type;
  if (type === 'number') return value instanceof ExactNumber;
  if (type === 'list') return Array.isArray(value);

  return isRecord(value);
}

/** A mismatch in a value, named by the attribute it is in. */
function mismatchAt(path: AttributePath, message: string): SchemaMismatch {
  return new SchemaMismatch(message, String(path[0]));
}

function numberIn(text: string, path: AttributePath): ExactNumber {
  try {
    return ExactNumber.parse(text);
  } catch (error) {
    if (error instanceof NumberError) throw mismatchAt(path, `${spelled(path)}: ${error.message}`);
    throw error;
  }
}

function booleanIn(text: string, path: AttributePath): boolean {
  if (text === 'true' || text === 'false') return text === 'true';

  throw mismatchAt(path, `${spelled(path)}: ${shown(text)} is not a boolean, which is "true" or "false"`);
}

/** A number or a boolean goes where a string does as its text, and a string where a number or a boolean does as the one it spells. */
function converted(type: SchemaType, value: unknown, path: AttributePath): unknown {
  if (type === 'string' && (value instanceof ExactNumber || typeof value === 'boolean')) return String(value);
  if (typeof value !== 'string') return value;
  if (type === 'number') return numberIn(value, path);
  if (type === 'boolean') return booleanIn(value, path);

  return value;
}

function entriesMapped(value: Record<string, unknown>, map: (name: string, item: unknown) => unknown): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, map(name, item)]));
}

type Conform = (definition: SchemaDefinition, value: unknown, path: AttributePath) => unknown;

/** What a value holds, each held to its definition. An object with no schema of its own, or a list or a map with no `elemType`, takes anything. */
function itemsConformed({ type, schema, elemType }: SchemaDefinition, value: unknown, path: AttributePath, conform: Conform): unknown {
  if (Array.isArray(value)) return elemType ? value.map((item, index) => conform({ type: elemType }, item, [...path, index])) : value;
  if (!isRecord(value)) return value;

  if (type === 'object') return schema ? entriesMapped(value, (name, item) => conform(schema[name], item, [...path, name])) : value;
  return elemType ? entriesMapped(value, (key, item) => conform({ type: elemType }, item, [...path, key])) : value;
}

function conformed(resource: string, definition: SchemaDefinition, written: unknown, path: AttributePath): unknown {
  if (isUnknown(written)) return written;

  const value = converted(definition.type, written, path);
  if (!isType(definition.type, value)) throw mismatchAt(path, `${spelled(path)} is ${kindOf(value)}, where ${resource} takes ${articles[definition.type]}`);

  const { schema } = definition;
  const named = definition.type === 'object' && schema && isRecord(value) ? nameProblem(resource, schema, Object.keys(value), path) : undefined;
  if (named) throw mismatchAt(path, named.message);

  return itemsConformed(definition, value, path, (held, item, at) => conformed(resource, held, item, at));
}

/**
 * Holds what the configuration sets to the schema: its names, and each value to the type the schema names, in every item it holds. A number or a boolean
 * where a string goes, and a string that spells a number or a boolean where one goes, is taken as that type. Only what is known is checked; a value the
 * apply makes is checked when the apply knows it. A saved plan's values reach the apply without the load's check, so the names are checked here too.
 */
export function conformValues(resource: string, schema: Schema, config: Record<string, unknown>): Record<string, unknown> {
  const named = nameProblem(resource, schema, Object.keys(config));
  if (named) throw new SchemaMismatch(named.message, named.set);

  return entriesMapped(config, (name, value) => conformed(resource, schema[name], value, [name]));
}
