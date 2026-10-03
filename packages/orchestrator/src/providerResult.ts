import { ExactNumber, isRecord, isType, isUnknown, Schema, unknownPaths } from '@clay/contracts';
import { Mismatch } from '@clay/planner';

import { shown } from './shown';
import { spelled } from './spelled';

export function kind(value: unknown): string {
  if (value instanceof ExactNumber) return 'an exact number';
  if (typeof value === 'number') return 'a JavaScript number';
  if (Array.isArray(value)) return 'a list';
  if (isRecord(value)) return 'a map';

  return value === null ? 'null' : `a ${typeof value}`;
}

/** Two values that show the same and differ, such as a JavaScript number and an exact one, are told apart by what they are. */
function kinds(planned: unknown, returned: unknown): string {
  return shown(planned) === shown(returned) ? ` (${kind(returned)} where the plan has ${kind(planned)})` : '';
}

function differs({ path, planned, returned }: Mismatch): string {
  const at = spelled(path);

  if (planned === undefined) return `${at} = ${shown(returned)}, which the plan did not have`;
  if (returned === undefined) return `${at} is missing, where the plan showed ${shown(planned)}`;

  return `${at} = ${shown(returned)}, where the plan showed ${shown(planned)}${kinds(planned, returned)}`;
}

/** How each check names its step, and a value it found not known. */
const steps = {
  apply: { did: 'returned', unknown: () => 'is not known; an apply returns every value' },
  plan: { did: 'planned at apply', unknown: (planned: unknown) => `is not known, where the plan showed ${shown(planned)}` },
};

/** The plan was approved as shown, so a provider that plans or makes something else has a bug, and the run stops on it. */
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

/** A value a read returns is planned against, so one not known, or a name the next plan would read as removed, is refused. */
export function checkRead(type: string, schema: Schema, read: Record<string, unknown>): void {
  refuse(type, 'resource', schema, read);
}

/** What a read returns is what a reference to the data source reads, so a value not known, or a name the schema does not have, is refused. */
export function checkDataSourceRead(type: string, schema: Schema, read: Record<string, unknown>): void {
  refuse(type, 'data source', schema, read);
}

/** A type is checked whole, since one a provider gets wrong would be refused only when a saved plan holding it is read back. */
function checkTypes(named: string, schema: Schema): void {
  for (const [name, definition] of Object.entries(schema))
    if (!isType(definition.type)) throw new Error(`${named} gives ${name} a type Clay cannot read, which is a bug in the provider`);
}

/** A schema comes from the provider, so one that says what cannot be is its bug, refused before anything is planned with it. */
export function checkSchema(type: string, schema: Schema): Schema {
  checkTypes(type, schema);
  for (const [name, definition] of Object.entries(schema))
    if (definition.kept && !definition.computed)
      throw new Error(`${type} keeps ${name}, which it does not compute; only a computed value can be kept, which is a bug in the provider`);

  return schema;
}

/** A data source is only read, never made or changed, so a schema that says when to remake it or what to keep is the provider's bug. */
export function checkDataSourceSchema(type: string, schema: Schema): Schema {
  checkTypes(`data source ${type}`, schema);
  for (const [name, definition] of Object.entries(schema)) {
    const flag = definition.forceNew ? 'forceNew' : definition.kept ? 'kept' : undefined;
    if (flag) throw new Error(`data source ${type} marks ${name} ${flag}, but only a resource can be ${flag}, which is a bug in the provider`);
  }

  return schema;
}
