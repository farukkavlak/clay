import { isDeepStrictEqual } from 'node:util';

import { Address, isInstanceKey, isModulePath } from './Address';
import type { InstanceKey, ModuleStep } from './Address';
import { ExactNumber, NumberError } from './ExactNumber';
import { isRecord } from './isRecord';
import { isType, types } from './Type';
import type { Type } from './Type';

export { Address, isInstanceKey, isModulePath, ModuleAddress, parseDataAddress, spellKey } from './Address';
export type { InstanceKey, ModuleStep } from './Address';
export { ExactNumber, NumberError } from './ExactNumber';
export { isRecord } from './isRecord';
export { isType, typeAt, types } from './Type';
export type { Type } from './Type';

/** A value known only after apply. A symbol, so no value from a configuration or a file can pass for it. */
export const UNKNOWN: unique symbol = Symbol('unknown');

export function isUnknown(value: unknown): boolean {
  return value === UNKNOWN;
}

/** Searches nested values: a plan may know a map but not one of its values. */
export function containsUnknown(value: unknown): boolean {
  if (isUnknown(value)) return true;
  if (Array.isArray(value)) return value.some((item) => containsUnknown(item));

  return isRecord(value) && Object.values(value).some((item) => containsUnknown(item));
}

/** `[[]]` when the whole value is unknown. */
export function unknownPaths(value: unknown, at: AttributePath = []): AttributePath[] {
  if (isUnknown(value)) return [at];
  if (Array.isArray(value)) return value.flatMap((item, index) => unknownPaths(item, [...at, index]));

  return isRecord(value) ? Object.entries(value).flatMap(([key, item]) => unknownPaths(item, [...at, key])) : [];
}

/** Own properties only, so `toString` finds nothing. */
export function own(values: Record<string, unknown>, name: string): unknown {
  return Object.hasOwn(values, name) ? values[name] : undefined;
}

export function valueAt(value: unknown, path: AttributePath): unknown {
  let at = value;

  for (const step of path)
    if (Array.isArray(at) && typeof step === 'number') at = at[step];
    else if (isRecord(at) && typeof step === 'string') at = own(at, step);
    else return undefined;

  return at;
}

/** Whatever the provider finds it by, such as an id, is one of its attributes. */
export interface Resource {
  resourceType: string;
  name: string;
  modulePath?: readonly ModuleStep[];
  key?: InstanceKey;
  attributes: Record<string, unknown>;
  /** Kept so it can be deleted before them once the config drops it. */
  dependencies?: string[];
}

/** Carries its type, which no schema names, so a reader can tell a set from a list. */
export interface Output {
  value: unknown;
  type: Type;
}

export function isOutput(output: unknown): output is Output {
  return isRecord(output) && Object.hasOwn(output, 'value') && isType(output.type);
}

export interface State {
  version: number;
  /** Bumped on each write. A saved plan records it, so a state written after the plan is caught. */
  serial: number;
  /** Root outputs from the last run. */
  outputs?: Record<string, Output>;
  resources: Record<string, Resource>;
}

/** Bump on any change to the shape after a release. A higher version was written by a newer Clay and is refused. */
export const STATE_VERSION = 3;

export function emptyState(): State {
  return { version: STATE_VERSION, serial: 0, resources: {} };
}

/** Checks what the engine reads without asking: the address fields, `attributes` and `dependencies`. */
function isResource(value: unknown): value is Resource {
  return (
    isRecord(value) &&
    typeof value.resourceType === 'string' &&
    typeof value.name === 'string' &&
    (value.modulePath === undefined || isModulePath(value.modulePath)) &&
    isRecord(value.attributes) &&
    (value.dependencies === undefined || Array.isArray(value.dependencies))
  );
}

/** Instance keys are part of the address, so they read back as plain numbers. */
function readKeys(resources: Record<string, unknown>): void {
  for (const [address, resource] of Object.entries(resources)) {
    if (!isRecord(resource)) continue;

    if (resource.key instanceof ExactNumber) resource.key = resource.key.toSafeInteger(`the key of "${address}"`);
    if (Array.isArray(resource.modulePath))
      for (const step of resource.modulePath) if (isRecord(step) && step.key instanceof ExactNumber) step.key = step.key.toSafeInteger(`a module key of "${address}"`);
  }
}

function checkResources(resources: Record<string, unknown>, say: (problem: string) => never): asserts resources is Record<string, Resource> {
  for (const [address, resource] of Object.entries(resources)) {
    if (!isResource(resource)) say(`"${address}" is not a resource`);
    if (resource.key !== undefined && !isInstanceKey(resource.key)) say(`the key of "${address}" is not a key: a key is a whole number or a string`);

    // Lookups use the key, but a delete is built from the entry's own fields, so they must agree.
    const held = Address.of(resource).toString();
    if (held !== address) say(`"${address}" holds ${held}`);
  }
}

/** Resources from a state or plan file, read with exact numbers: keys become plain numbers, then each resource is checked. */
export function readResources(resources: unknown, field: string, say: (problem: string) => never): asserts resources is Record<string, Resource> {
  if (!isRecord(resources)) say(`${field} are not a record`);

  try {
    readKeys(resources);
  } catch (error) {
    if (error instanceof NumberError) say(error.message);

    throw error;
  }

  checkResources(resources, say);
}

export interface SchemaDefinition {
  type: Type;
  required?: boolean;
  /** A change to it replaces the resource. */
  forceNew?: boolean;
  /** Set by the provider; the configuration may set it only with `optional`. A plan with no change keeps it as read; any change recomputes it unless `kept`. */
  computed?: boolean;
  /** With `computed`: the configuration may set it, and the provider computes it otherwise. */
  optional?: boolean;
  /** With `computed`: fixed at create until replace, so an update keeps it as read. */
  kept?: boolean;
}

export type Schema = Record<string, SchemaDefinition>;

export function typeIn(schema: Schema, name: string): Type {
  return Object.hasOwn(schema, name) ? schema[name].type : types.dynamic;
}

/** The attribute name, then map keys and list indexes. */
export type AttributePath = (string | number)[];

/** A create when `prior` is null, else a change. */
export interface PlanRequest {
  /** As the refresh read it. */
  prior: Record<string, unknown> | null;
  /** The configuration's values, plus computed values from `prior` the configuration does not set. */
  proposed: Record<string, unknown>;
  /** The configuration's values alone, to tell an optional computed value it sets from one kept from `prior`. */
  config: Record<string, unknown>;
}

export interface PlannedChange {
  /** UNKNOWN where only the apply knows a value. A value the configuration sets must stay as set. */
  after: Record<string, unknown>;
  /** Attributes whose change forces a replace. */
  replace: AttributePath[];
}

export interface CreateRequest {
  config: Record<string, unknown>;
  /** The provider's plan at apply; UNKNOWN where only the apply knows a value. */
  planned: Record<string, unknown>;
}

export interface UpdateRequest extends CreateRequest {
  /** As state holds it, so the provider can find it. */
  prior: Record<string, unknown>;
}

/**
 * A plan from the schema alone. With no change the resource stays as read. With a change, computed values the configuration does not set
 * become UNKNOWN unless `kept`, and a changed `forceNew` attribute replaces the resource.
 */
export function planFromSchema(schema: Schema, { prior, proposed, config }: PlanRequest): PlannedChange {
  if (prior !== null && isDeepStrictEqual(prior, proposed)) return { after: prior, replace: [] };

  const kept = (name: string) => schema[name].kept && Object.hasOwn(proposed, name);
  const remade = Object.keys(schema).filter((name) => schema[name].computed && !Object.hasOwn(config, name) && !kept(name));
  const after = Object.fromEntries([...Object.entries(proposed), ...remade.map((name) => [name, UNKNOWN])]);
  if (prior === null) return { after, replace: [] };

  const replacing = Object.keys(schema).filter((name) => schema[name].forceNew && !isDeepStrictEqual(own(prior, name), own(proposed, name)));
  return { after, replace: replacing.map((name) => [name]) };
}

/** Numbers in inputs arrive as `ExactNumber`, never rounded. */
export interface Provider {
  readonly resources: string[];

  /** A type may also be a resource type, as a file is both written and read. */
  readonly dataSources: string[];

  getSchema(type: string): Promise<Schema>;

  /** Throws on invalid inputs. An input may be UNKNOWN until apply, and is checked then. */
  validate(type: string, inputs: Record<string, unknown>): Promise<void>;

  /** `planFromSchema` is a default that plans from the schema alone. */
  plan(type: string, request: PlanRequest): Promise<PlannedChange>;

  /** The resource as it is now, or `null` when it no longer exists. */
  read(type: string, prior: Record<string, unknown>): Promise<Record<string, unknown> | null>;

  /** Separate from the resource schema, since one type may be both with different attributes. */
  getDataSourceSchema(type: string): Promise<Schema>;

  validateDataSource(type: string, inputs: Record<string, unknown>): Promise<void>;

  readDataSource(type: string, inputs: Record<string, unknown>): Promise<Record<string, unknown>>;

  /** Returns the whole resource, computed values included. */
  create(type: string, request: CreateRequest): Promise<Record<string, unknown>>;
  /** Returns the whole resource. */
  update(type: string, request: UpdateRequest): Promise<Record<string, unknown>>;
  delete(type: string, prior: Record<string, unknown>): Promise<void>;
}

export interface ResourceHandler {
  getSchema(): Promise<Schema>;

  validate(inputs: Record<string, unknown>): Promise<void>;

  plan(request: PlanRequest): Promise<PlannedChange>;

  read(prior: Record<string, unknown>): Promise<Record<string, unknown> | null>;

  /** Returns the whole resource, computed values included. */
  create(request: CreateRequest): Promise<Record<string, unknown>>;

  /** Returns the whole resource. */
  update(request: UpdateRequest): Promise<Record<string, unknown>>;

  delete(prior: Record<string, unknown>): Promise<void>;
}

export interface DataSourceHandler {
  getSchema(): Promise<Schema>;

  validate(inputs: Record<string, unknown>): Promise<void>;

  read(inputs: Record<string, unknown>): Promise<Record<string, unknown>>;
}
