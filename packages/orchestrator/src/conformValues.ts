import { AttributePath, ExactNumber, isRecord, isUnknown, NumberError, Schema, Type, UNKNOWN } from '@clay/contracts';
import { DataBlock, Position, ResourceBlock } from '@clay/parser';

import { setOf } from './setMembers';
import { shown } from './shown';
import { items, spelled } from './spelled';
import { article, child, described, unordered, Value, valueOf } from './Value';

/** Carries the attribute, so the caller can report its position; undefined for a missing attribute. */
export class SchemaMismatch extends Error {
  constructor(
    message: string,
    readonly attribute?: string
  ) {
    super(message);
    this.name = 'SchemaMismatch';
  }
}

export function writtenAt(error: unknown, block: ResourceBlock | DataBlock): Position {
  return error instanceof SchemaMismatch && error.attribute !== undefined ? block.attributes[error.attribute].position : block.position;
}

/** `set` is the offending name when it was written, so it has a position. */
export interface NameProblem {
  message: string;
  set?: string;
}

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

/** Reports an unknown name before a missing required one. */
export function nameProblem(resource: string, { known, required }: Names, names: string[], within: AttributePath = []): NameProblem | undefined {
  const where = within.length > 0 ? ` in ${spelled(within)}` : '';

  const unnamed = names.find((name) => !known.includes(name));
  if (unnamed !== undefined) return { message: `${resource} has no attribute "${unnamed}"${where}`, set: unnamed };

  const missing = required.find((name) => !names.includes(name));
  return missing === undefined ? undefined : { message: `${resource} requires "${missing}"${where}` };
}

function mismatchAt(path: AttributePath, message: string): SchemaMismatch {
  return new SchemaMismatch(message, String(path[0]));
}

/** Allowed conversions: a number or bool to its text, a string to the number or bool it spells, and a collection to another. */
const TAKES: Record<Type['kind'], readonly Type['kind'][]> = {
  string: ['string', 'number', 'bool'],
  number: ['number', 'string'],
  bool: ['bool', 'string'],
  dynamic: [],
  list: ['list', 'set', 'tuple'],
  set: ['list', 'set', 'tuple'],
  tuple: ['list', 'set', 'tuple'],
  map: ['map', 'object'],
  object: ['map', 'object'],
};

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

function primitive(kind: Type['kind'], data: unknown, path: AttributePath): unknown {
  if (kind === 'string') return String(data);
  if (typeof data !== 'string') return data;

  return kind === 'number' ? numberIn(data, path) : booleanIn(data, path);
}

type Convert = (value: Value, to: Type, path: AttributePath) => Value;

function entriesConverted(value: Value, typeOf: (name: string) => Type, path: AttributePath, convert: Convert): Record<string, unknown> {
  return Object.fromEntries(Object.keys(value.data as Record<string, unknown>).map((name) => [name, convert(child(value, name), typeOf(name), [...path, name]).data]));
}

function itemsConverted(value: Value, typeOf: (index: number) => Type, path: AttributePath, convert: Convert): unknown[] {
  return (value.data as unknown[]).map((_, index) => convert(child(value, index), typeOf(index), [...path, index]).data);
}

/** A set is deduplicated and ordered after conversion. */
function collection(resource: string, value: Value, to: Type, path: AttributePath, convert: Convert): unknown {
  if (to.kind === 'list' || to.kind === 'set') {
    const elements = itemsConverted(value, () => to.element, path, convert);
    return to.kind === 'set' ? setOf(elements) : elements;
  }
  if (to.kind === 'map') return entriesConverted(value, () => to.element, path, convert);

  if (to.kind === 'tuple') {
    const { length } = value.data as unknown[];
    if (length !== to.elements.length) throw mismatchAt(path, `${spelled(path)} holds ${items(length)}, where ${resource} takes ${items(to.elements.length)}`);
    return itemsConverted(value, (index) => to.elements[index], path, convert);
  }

  const named = nameProblem(resource, namesOfObject(to as Extract<Type, { kind: 'object' }>), Object.keys(value.data as Record<string, unknown>), path);
  if (named) throw mismatchAt(path, named.message);
  return entriesConverted(value, (name) => (to as Extract<Type, { kind: 'object' }>).attributes[name], path, convert);
}

/** Only a set can hold a set with an unknown member before apply. */
function knownLater(value: Value, to: Type): boolean {
  return isUnknown(value.data) || (to.kind !== 'set' && unordered(value));
}

/** For `dynamic`, a set with an unknown member becomes UNKNOWN, since its data alone would read as a list. */
function ordered(value: Value): unknown {
  if (unordered(value)) return UNKNOWN;
  if (Array.isArray(value.data)) return value.data.map((_, index) => ordered(child(value, index)));
  if (isRecord(value.data)) return Object.fromEntries(Object.keys(value.data).map((name) => [name, ordered(child(value, name))]));

  return value.data;
}

/** An unknown is checked only for its kind here; it is checked again at apply. */
export function converted(resource: string, value: Value, to: Type, path: AttributePath): Value {
  if (to.kind === 'dynamic') return valueOf(value.type, ordered(value));
  if (value.data === null) return valueOf(to, null);

  const from = value.type.kind;
  if (from !== 'dynamic' && !TAKES[to.kind].includes(from)) throw mismatchAt(path, `${spelled(path)} is ${described(value)}, where ${resource} takes ${article(to.kind)}`);
  if (knownLater(value, to)) return valueOf(to, UNKNOWN);

  const convert: Convert = (item, type, at) => converted(resource, item, type, at);
  const isPrimitive = to.kind === 'string' || to.kind === 'number' || to.kind === 'bool';
  return valueOf(to, isPrimitive ? primitive(to.kind, value.data, path) : collection(resource, value, to, path, convert));
}

/** A name set to null counts as missing, so a required one is refused at its position. */
function checkNames(resource: string, schema: Schema, config: Record<string, Value>): void {
  const named = nameProblem(resource, { known: Object.keys(schema), required: [] }, Object.keys(config));
  if (named) throw new SchemaMismatch(named.message, named.set);

  const missing = namesOf(schema).required.find((name) => !Object.hasOwn(config, name) || config[name].data === null);
  if (missing !== undefined) throw new SchemaMismatch(`${resource} requires "${missing}"`, Object.hasOwn(config, missing) ? missing : undefined);
}

/**
 * Converts configuration values to the schema's types, as the provider receives them. A name set to null is dropped.
 * Names are checked here too, since a saved plan's values reach the apply without the load-time check.
 */
export function conformValues(resource: string, schema: Schema, config: Record<string, Value>): Record<string, unknown> {
  checkNames(resource, schema, config);

  const given = Object.entries(config).filter(([, value]) => value.data !== null);
  return Object.fromEntries(given.map(([name, value]) => [name, converted(resource, value, schema[name].type, [name]).data]));
}
