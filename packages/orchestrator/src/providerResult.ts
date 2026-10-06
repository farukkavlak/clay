import { isType, isUnknown, Schema, unknownPaths } from '@clay/contracts';
import { Mismatch, offFinal } from '@clay/planner';

import { shown } from './shown';
import { spelled } from './spelled';
import { TypeMismatch, typedValues } from './typed';
import { Value } from './Value';

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
export function inconsistent(type: string, step: keyof typeof steps, mismatches: Mismatch[]): Error {
  const { did, unknown } = steps[step];
  const line = (mismatch: Mismatch) => (isUnknown(mismatch.returned) ? `${spelled(mismatch.path)} ${unknown(mismatch.planned)}` : differs(mismatch));

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
export function checkDataSourceGiven(type: string, schema: Schema, given: Record<string, unknown>, read: Record<string, unknown>): void {
  const both = Object.keys(given).filter((name) => Object.hasOwn(read, name));
  const only = (values: Record<string, unknown>) => Object.fromEntries(both.map((name) => [name, values[name]]));
  const changed = offFinal(schema, only(given), only(read));
  if (changed.length === 0) return;

  const lines = changed.map(({ path, planned, returned }) => `  ${spelled(path)} = ${shown(returned)}, where the configuration gave ${shown(planned)}`);
  throw new Error([`${type} read what its configuration did not give, which is a bug in the provider:`, ...lines].join('\n'));
}

/** Otherwise a bad type would only fail when a saved plan holding it is read back. */
function checkTypes(named: string, schema: Schema): void {
  for (const [name, definition] of Object.entries(schema))
    if (!isType(definition.type)) throw new Error(`${named} gives ${name} a type Clay cannot read, which is a bug in the provider`);
}

/** An invalid schema is a provider bug, refused before anything is planned with it. */
export function checkSchema(type: string, schema: Schema): Schema {
  checkTypes(type, schema);
  for (const [name, definition] of Object.entries(schema))
    if (definition.kept && !definition.computed)
      throw new Error(`${type} keeps ${name}, which it does not compute; only a computed value can be kept, which is a bug in the provider`);

  return schema;
}

/** A data source is only read, so `forceNew` or `kept` in its schema is a provider bug. */
export function checkDataSourceSchema(type: string, schema: Schema): Schema {
  checkTypes(`data source ${type}`, schema);
  for (const [name, definition] of Object.entries(schema)) {
    const flag = definition.forceNew ? 'forceNew' : definition.kept ? 'kept' : undefined;
    if (flag) throw new Error(`data source ${type} marks ${name} ${flag}, but only a resource can be ${flag}, which is a bug in the provider`);
  }

  return schema;
}

/** A value of the wrong type is a provider bug; `did` names the step in the message. */
export function heldBy(type: string, did: string, schema: Schema, values: Record<string, unknown>): Record<string, Value> {
  try {
    return typedValues(schema, values);
  } catch (error) {
    if (error instanceof TypeMismatch) throw new Error(`${type} ${did} what its schema does not hold, which is a bug in the provider: ${error.message}`, { cause: error });
    throw error;
  }
}
