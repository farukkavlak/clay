import {
  AttributePath,
  containsUnknown,
  isType,
  isUnknown,
  MAX_NESTING,
  nestingOf,
  Schema,
  SchemaDefinition,
  touchesSensitive,
  typeNestingOf,
  unknownPaths,
} from '@clay/contracts';
import { Mismatch, offFinal } from '@clay/planner';
import { isDeepStrictEqual } from 'node:util';

import { shown } from '../shown';
import { spelled } from '../spelled';
import { TypeMismatch, typedValues } from '../values/typed';
import { plainOf, Value } from '../values/Value';

/** Says that a sensitive value differs and nothing of either value, as the difference itself could give it away. */
export function undisclosed(path: AttributePath): string {
  return `${spelled(path)}: inconsistent values for sensitive attribute`;
}

function differs({ path, planned, returned }: Mismatch): string {
  const at = spelled(path);

  if (planned === undefined) return `${at} = ${shown(returned)}, which the plan did not have`;
  if (returned === undefined) return `${at} is missing, where the plan showed ${shown(planned)}`;

  return `${at} = ${shown(returned)}, where the plan showed ${shown(planned)}`;
}

const steps = {
  apply: { did: 'returned', unknown: () => 'is not known; an apply returns every value' },
  plan: { did: 'planned at apply', unknown: (planned: unknown) => `is not known, where the plan showed ${shown(planned)}` },
};

/** The plan was approved as shown, so any deviation is a provider bug and stops the run. */
export function inconsistent(type: string, step: keyof typeof steps, mismatches: Mismatch[], sensitive: readonly AttributePath[]): Error {
  const { did, unknown } = steps[step];
  const describe = (mismatch: Mismatch) => (isUnknown(mismatch.returned) ? `${spelled(mismatch.path)} ${unknown(mismatch.planned)}` : differs(mismatch));
  const line = (mismatch: Mismatch) => (touchesSensitive(sensitive, mismatch.path) ? undisclosed(mismatch.path) : describe(mismatch));

  return new Error([`${type} ${did} what the plan did not show, which is a bug in the provider:`, ...mismatches.map((mismatch) => `  ${line(mismatch)}`)].join('\n'));
}

function unknownIn(name: string, value: unknown): string[] {
  return unknownPaths(value, [name]).map((path) => `${spelled(path)} is not known; a read returns every value`);
}

function oddRead(schema: Schema, name: string, value: unknown): string[] {
  const unknown = unknownIn(name, value);
  if (unknown.length > 0) return unknown;

  return Object.hasOwn(schema, name) ? [] : [`${name} = ${shown(value)}, which the schema does not have`];
}

function refuse(type: string, what: string, schema: Schema, read: Record<string, unknown>): void {
  const lines = Object.entries(read).flatMap(([name, value]) => oddRead(schema, name, value));
  if (lines.length > 0) throw new Error([`${type} read what the ${what} cannot hold, which is a bug in the provider:`, ...lines.map((odd) => `  ${odd}`)].join('\n'));
}

/** Plans are made against a read, so an unknown or a name outside the schema is refused. */
export function checkRead(type: string, schema: Schema, read: Record<string, unknown>): void {
  refuse(type, 'resource', schema, read);
}

/** References read this directly, so an unknown or a name outside the schema is refused. */
export function checkDataSourceRead(type: string, schema: Schema, read: Record<string, unknown>): void {
  refuse(type, 'data source', schema, read);
}

/** What the configuration gave belongs to the configuration, so a read may leave it out but not change it. */
export function checkDataSourceGiven(type: string, schema: Schema, given: Record<string, unknown>, read: Record<string, unknown>, sensitive: readonly AttributePath[]): void {
  const both = Object.keys(given).filter((name) => Object.hasOwn(read, name));
  const only = (values: Record<string, unknown>) => Object.fromEntries(both.map((name) => [name, values[name]]));
  const changed = offFinal(schema, only(given), only(read));
  if (changed.length === 0) return;

  const lines = changed.map(({ path, planned, returned }) =>
    touchesSensitive(sensitive, path) ? `  ${undisclosed(path)}` : `  ${spelled(path)} = ${shown(returned)}, where the configuration gave ${shown(planned)}`
  );
  throw new Error([`${type} read what its configuration did not give, which is a bug in the provider:`, ...lines].join('\n'));
}

/** Otherwise a bad type would only fail when a saved plan holding it is read back. */
function checkTypes(named: string, schema: Schema): void {
  for (const [name, definition] of Object.entries(schema)) {
    if (!isType(definition.type)) throw new Error(`${named} gives ${name} a type Clay cannot read, which is a bug in the provider`);
    if (typeNestingOf(definition.type) > MAX_NESTING) throw new Error(`${named} gives ${name} a type nested more than ${MAX_NESTING} levels deep, which is a bug in the provider`);
  }
}

function sensitiveWithProblem(schema: Schema, name: string, { computed, sensitiveWith }: SchemaDefinition): string | undefined {
  if (sensitiveWith === undefined) return undefined;
  if (!Array.isArray(sensitiveWith) || !sensitiveWith.every((other) => typeof other === 'string')) return 'something other than a list of names';
  if (!computed) return 'others, which it does not compute; only a computed value can be';
  if (sensitiveWith.includes(name)) return 'itself';
  const unknown = sensitiveWith.find((other) => !Object.hasOwn(schema, other));
  return unknown === undefined ? undefined : `${unknown}, an attribute it does not have`;
}

/** A value made from another must name one the configuration can give, or no mark would ever reach it. */
function checkSensitiveWith(named: string, schema: Schema): void {
  for (const [name, definition] of Object.entries(schema)) {
    const problem = sensitiveWithProblem(schema, name, definition);
    if (problem) throw new Error(`${named} marks ${name} sensitive with ${problem}, which is a bug in the provider`);
  }
}

/** As a plan holds it, or undefined where its type does not hold it. */
function heldDefault(name: string, definition: SchemaDefinition): unknown {
  try {
    return plainOf(typedValues({ [name]: definition }, { [name]: definition.default }))[name];
  } catch (error) {
    if (error instanceof TypeMismatch) return undefined;
    throw error;
  }
}

/** A default stands in for what the configuration leaves out, so it must be a value the configuration could set, written as a plan holds it. */
function checkDefault(type: string, name: string, definition: SchemaDefinition): void {
  const bug = (problem: string) => new Error(`${type} gives ${name} a default${problem}, which is a bug in the provider`);

  if (definition.default === undefined) return;
  if (definition.default === null) throw bug(' of null');
  if (nestingOf(definition.default) > MAX_NESTING) throw bug(` nested more than ${MAX_NESTING} levels deep`);
  if (containsUnknown(definition.default)) throw bug(' that is not known');
  if (definition.required) throw bug(', but it is required');
  if (definition.computed) throw bug(', but it computes it');

  const held = heldDefault(name, definition);
  if (held === undefined) throw bug(' its type does not hold');
  if (!isDeepStrictEqual(held, definition.default)) throw bug(` its type holds as ${shown(held)}`);
}

/** An invalid schema is a provider bug, refused before anything is planned with it. */
export function checkSchema(type: string, schema: Schema): Schema {
  checkTypes(type, schema);
  checkSensitiveWith(type, schema);
  for (const [name, definition] of Object.entries(schema)) {
    if (definition.kept && !definition.computed)
      throw new Error(`${type} keeps ${name}, which it does not compute; only a computed value can be kept, which is a bug in the provider`);
    checkDefault(type, name, definition);
  }

  return schema;
}

/** A data source is only read, so `forceNew` or `kept` in its schema is a provider bug. */
export function checkDataSourceSchema(type: string, schema: Schema): Schema {
  checkTypes(`data source ${type}`, schema);
  checkSensitiveWith(`data source ${type}`, schema);
  for (const [name, definition] of Object.entries(schema)) {
    const flag = definition.forceNew ? 'forceNew' : definition.kept ? 'kept' : undefined;
    if (flag) throw new Error(`data source ${type} marks ${name} ${flag}, but only a resource can be ${flag}, which is a bug in the provider`);
    if (definition.default !== undefined) throw new Error(`data source ${type} gives ${name} a default, but only a resource can have one, which is a bug in the provider`);
  }

  return schema;
}

/** Names what is nested too deep for Clay to hold, since every walk over a value recurses. */
export function tooDeep(values: Record<string, unknown>): string[] {
  return Object.keys(values).filter((name) => nestingOf(values[name]) > MAX_NESTING);
}

/** Refused before anything walks it, which could overflow the stack. */
export function checkNesting(type: string, did: string, values: Record<string, unknown>): void {
  const lines = tooDeep(values).map((name) => `  ${spelled([name])} is nested more than ${MAX_NESTING} levels deep`);
  if (lines.length > 0) throw new Error([`${type} ${did} what Clay cannot hold, which is a bug in the provider:`, ...lines].join('\n'));
}

/** A value of the wrong type or nested too deep is a provider bug; `did` names the step in the message. */
export function heldBy(type: string, did: string, schema: Schema, values: Record<string, unknown>): Record<string, Value> {
  checkNesting(type, did, values);
  try {
    return typedValues(schema, values);
  } catch (error) {
    if (error instanceof TypeMismatch) throw new Error(`${type} ${did} what its schema does not hold, which is a bug in the provider: ${error.message}`, { cause: error });
    throw error;
  }
}

/** A provider words what it throws itself, a string too, and may quote what it was given, so with a sensitive value given none of it is shown. */
export async function hidingReason<T>(type: string, sensitive: readonly AttributePath[], ask: () => Promise<T>, doing = 'on its configuration'): Promise<T> {
  try {
    return await ask();
  } catch (error) {
    if (sensitive.length === 0) throw error;
    throw new Error(`${type} failed ${doing}; a value given to it is sensitive, so the reason is not shown`);
  }
}
