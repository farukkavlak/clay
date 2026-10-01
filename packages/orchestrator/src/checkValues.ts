import { AttributePath, ExactNumber, isRecord, isUnknown, Schema, SchemaDefinition, SchemaType } from '@clay/contracts';
import { DataBlock, Position, ResourceBlock } from '@clay/parser';

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

function firstOf<T>(items: T[], problem: (item: T) => string | undefined): string | undefined {
  for (const item of items) {
    const found = problem(item);
    if (found !== undefined) return found;
  }

  return undefined;
}

/** What a value holds, each with the definition it is held to. An object with no schema of its own, or a list or a map with no `elemType`, takes anything. */
function itemsOf({ type, schema, elemType }: SchemaDefinition, value: unknown): [string | number, SchemaDefinition, unknown][] {
  if (Array.isArray(value)) return elemType ? value.map((item, index) => [index, { type: elemType }, item]) : [];
  if (!isRecord(value)) return [];

  const entries = Object.entries(value);
  if (type === 'object') return schema ? entries.map(([name, item]) => [name, schema[name], item]) : [];
  return elemType ? entries.map(([key, item]) => [key, { type: elemType }, item]) : [];
}

function problemIn(resource: string, definition: SchemaDefinition, value: unknown, path: AttributePath): string | undefined {
  if (isUnknown(value)) return undefined;
  if (!isType(definition.type, value)) return `${spelled(path)} is ${kindOf(value)}, where ${resource} takes ${articles[definition.type]}`;

  const { schema } = definition;
  const named = definition.type === 'object' && schema && isRecord(value) ? nameProblem(resource, schema, Object.keys(value), path)?.message : undefined;
  return named ?? firstOf(itemsOf(definition, value), ([step, held, item]) => problemIn(resource, held, item, [...path, step]));
}

/**
 * Holds what the configuration sets to the schema: its names, and each value to the type the schema names, in every item it holds. Only what is known is
 * checked; a value the apply makes is checked when the apply knows it. A saved plan's values reach the apply without the load's check, so the names are
 * checked here too.
 */
export function checkValues(resource: string, schema: Schema, config: Record<string, unknown>): void {
  const named = nameProblem(resource, schema, Object.keys(config));
  if (named) throw new SchemaMismatch(named.message, named.set);

  for (const [name, value] of Object.entries(config)) {
    const problem = problemIn(resource, schema[name], value, [name]);
    if (problem !== undefined) throw new SchemaMismatch(problem, name);
  }
}
