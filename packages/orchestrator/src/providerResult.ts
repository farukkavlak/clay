import { ExactNumber, isRecord, isUnknown, Schema, unknownPaths } from '@clay/contracts';
import { Mismatch } from '@clay/planner';

import { shown } from './shown';

function spelled(path: Mismatch['path']): string {
  const [name, ...steps] = path;

  return String(name) + steps.map((step) => `[${JSON.stringify(step)}]`).join('');
}

function kind(value: unknown): string {
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

function line({ path, planned, returned }: Mismatch): string {
  const at = spelled(path);

  if (isUnknown(returned)) return `${at} is not known; an apply returns every value`;
  if (planned === undefined) return `${at} = ${shown(returned)}, which the plan did not have`;
  if (returned === undefined) return `${at} is missing, where the plan showed ${shown(planned)}`;

  return `${at} = ${shown(returned)}, where the plan showed ${shown(planned)}${kinds(planned, returned)}`;
}

/** The plan was approved as shown, so a provider that makes something else has a bug, and the run stops on it. */
export function inconsistentResult(type: string, mismatches: Mismatch[]): Error {
  return new Error([`${type} returned what the plan did not show, which is a bug in the provider:`, ...mismatches.map((mismatch) => `  ${line(mismatch)}`)].join('\n'));
}

function unknownIn(name: string, value: unknown): string[] {
  return unknownPaths(value, [name]).map((path) => `${spelled(path)} is not known; a read returns every value`);
}

function oddRead(schema: Schema, prior: Record<string, unknown>, name: string, value: unknown): string[] {
  const unknown = unknownIn(name, value);
  if (unknown.length > 0) return unknown;

  return Object.hasOwn(schema, name) || Object.hasOwn(prior, name) ? [] : [`${name} = ${shown(value)}, which neither the schema nor the resource has`];
}

function refuse(type: string, what: string, lines: string[]): void {
  if (lines.length > 0) throw new Error([`${type} read what the ${what} cannot hold, which is a bug in the provider:`, ...lines.map((odd) => `  ${odd}`)].join('\n'));
}

/**
 * A value a read returns is planned against, so one not known, or a name the next plan would read as removed, is refused. A name the resource held already
 * passes, since nothing checks what a configuration sets against the schema yet.
 */
export function checkRead(type: string, schema: Schema, prior: Record<string, unknown>, read: Record<string, unknown>): void {
  refuse(
    type,
    'resource',
    Object.entries(read).flatMap(([name, value]) => oddRead(schema, prior, name, value))
  );
}

/** A data source has no schema yet, so only a value not known is refused. */
export function checkDataSourceRead(type: string, read: Record<string, unknown>): void {
  refuse(
    type,
    'data source',
    Object.entries(read).flatMap(([name, value]) => unknownIn(name, value))
  );
}

function checkDefinitions(type: string, schema: Schema, within: string): void {
  for (const [name, definition] of Object.entries(schema)) {
    const at = within + name;
    if (definition.kept && !definition.computed)
      throw new Error(`${type} keeps ${at}, which it does not compute; only a computed value can be kept, which is a bug in the provider`);
    if (definition.schema) checkDefinitions(type, definition.schema, `${at}.`);
  }
}

/** A schema comes from the provider, so one that says what cannot be is its bug, refused before anything is planned with it. */
export function checkSchema(type: string, schema: Schema): Schema {
  checkDefinitions(type, schema, '');

  return schema;
}
