import { AttributePath, ExactNumber, isRecord, isUnknown, NumberError, Schema, Type } from '@clay/contracts';
import { DataBlock, Position, ResourceBlock } from '@clay/parser';

import { setsOrdered } from './setOrder';
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

/** The names a resource or an object in it has, and those of them it requires. */
interface Names {
  known: string[];
  required: string[];
}

export function namesOf(schema: Schema): Names {
  const known = Object.keys(schema);
  return { known, required: known.filter((name) => schema[name].required) };
}

function namesOfObject(type: Extract<Type, { kind: 'object' }>): Names {
  const known = Object.keys(type.attributes);
  return { known, required: known.filter((name) => !type.optional?.includes(name)) };
}

/** A name it does not have comes first, then one it requires that is left out. */
export function nameProblem(resource: string, { known, required }: Names, names: string[], within: AttributePath = []): NameProblem | undefined {
  const where = within.length > 0 ? ` in ${spelled(within)}` : '';

  const unnamed = names.find((name) => !known.includes(name));
  if (unnamed !== undefined) return { message: `${resource} has no attribute "${unnamed}"${where}`, set: unnamed };

  const missing = required.find((name) => !names.includes(name));
  return missing === undefined ? undefined : { message: `${resource} requires "${missing}"${where}` };
}

const articles: Record<Type['kind'], string> = {
  string: 'a string',
  number: 'a number',
  bool: 'a boolean',
  dynamic: 'any value',
  list: 'a list',
  set: 'a set',
  map: 'a map',
  object: 'an object',
  tuple: 'a tuple',
};

function kindOf(value: unknown): string {
  if (value instanceof ExactNumber) return 'a number';
  if (Array.isArray(value)) return 'a list';
  if (isRecord(value)) return 'a map';

  return `a ${typeof value}`;
}

function holds(kind: Type['kind'], value: unknown): boolean {
  if (kind === 'dynamic') return true;
  if (kind === 'string') return typeof value === 'string';
  if (kind === 'bool') return typeof value === 'boolean';
  if (kind === 'number') return value instanceof ExactNumber;
  if (kind === 'list' || kind === 'set' || kind === 'tuple') return Array.isArray(value);

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
function converted(kind: Type['kind'], value: unknown, path: AttributePath): unknown {
  if (kind === 'string' && (value instanceof ExactNumber || typeof value === 'boolean')) return String(value);
  if (typeof value !== 'string') return value;
  if (kind === 'number') return numberIn(value, path);
  if (kind === 'bool') return booleanIn(value, path);

  return value;
}

function entriesMapped(value: Record<string, unknown>, map: (name: string, item: unknown) => unknown): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, map(name, item)]));
}

type Conform = (type: Type, value: unknown, path: AttributePath) => unknown;

/** What a value holds, each held to the type its place in the value names. */
function itemsConformed(type: Type, value: unknown, path: AttributePath, conform: Conform): unknown {
  if (type.kind === 'tuple') return (value as unknown[]).map((item, index) => conform(type.elements[index], item, [...path, index]));
  if (type.kind === 'object') return entriesMapped(value as Record<string, unknown>, (name, item) => conform(type.attributes[name], item, [...path, name]));
  if (type.kind !== 'list' && type.kind !== 'set' && type.kind !== 'map') return value;

  const { element } = type;
  if (Array.isArray(value)) return value.map((item, index) => conform(element, item, [...path, index]));
  return entriesMapped(value as Record<string, unknown>, (key, item) => conform(element, item, [...path, key]));
}

const items = (count: number): string => `${count} ${count === 1 ? 'item' : 'items'}`;

/** What the value's shape lacks for its type: an object's names, or a tuple's length. */
function shapeProblem(resource: string, type: Type, value: unknown, path: AttributePath): string | undefined {
  if (type.kind === 'object') return nameProblem(resource, namesOfObject(type), Object.keys(value as Record<string, unknown>), path)?.message;
  if (type.kind !== 'tuple') return undefined;

  const { length } = value as unknown[];
  return length === type.elements.length ? undefined : `${spelled(path)} holds ${items(length)}, where ${resource} takes ${items(type.elements.length)}`;
}

function conformed(resource: string, type: Type, written: unknown, path: AttributePath): unknown {
  if (isUnknown(written)) return written;

  const value = converted(type.kind, written, path);
  if (!holds(type.kind, value)) throw mismatchAt(path, `${spelled(path)} is ${kindOf(value)}, where ${resource} takes ${articles[type.kind]}`);

  const problem = shapeProblem(resource, type, value, path);
  if (problem) throw mismatchAt(path, problem);

  return itemsConformed(type, value, path, (held, item, at) => conformed(resource, held, item, at));
}

/**
 * Holds what the configuration sets to the schema: its names, and each value to the type the schema names, in every item it holds. A number or a boolean
 * where a string goes, and a string that spells a number or a boolean where one goes, is taken as that type. Only what is known is checked; a value the
 * apply makes is checked when the apply knows it. A saved plan's values reach the apply without the load's check, so the names are checked here too.
 * Each set comes back in one order, with each member once.
 */
export function conformValues(resource: string, schema: Schema, config: Record<string, unknown>): Record<string, unknown> {
  const named = nameProblem(resource, namesOf(schema), Object.keys(config));
  if (named) throw new SchemaMismatch(named.message, named.set);

  return setsOrdered(
    schema,
    entriesMapped(config, (name, value) => conformed(resource, schema[name].type, value, [name]))
  );
}
