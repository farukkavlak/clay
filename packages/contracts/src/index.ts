import { isDeepStrictEqual } from 'node:util';

import { Address, isInstanceKey, isModulePath } from './Address';
import type { InstanceKey, ModuleStep } from './Address';
import { ExactNumber, NumberError } from './ExactNumber';

export { Address, isInstanceKey, isModulePath, ModuleAddress } from './Address';
export type { InstanceKey, ModuleStep } from './Address';
export { ExactNumber, NumberError } from './ExactNumber';

/** A plain object, as JSON makes one: a number read from a file is an ExactNumber, which is no record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;

  const prototype: unknown = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}

/** Stands for a value that only exists once the resources it depends on are created. A symbol, so no value a configuration or a file holds can pass for it. */
export const UNKNOWN: unique symbol = Symbol('unknown');

export function isUnknown(value: unknown): boolean {
  return value === UNKNOWN;
}

/** Whether a value, or anything a list or a map in it holds, is not known yet: a plan may know a map and not one of its values. */
export function containsUnknown(value: unknown): boolean {
  if (isUnknown(value)) return true;
  if (Array.isArray(value)) return value.some((item) => containsUnknown(item));

  return isRecord(value) && Object.values(value).some((item) => containsUnknown(item));
}

/** Where a value holds what is not known yet, as the steps to each; `[[]]` when the whole of it is not. */
export function unknownPaths(value: unknown, at: AttributePath = []): AttributePath[] {
  if (isUnknown(value)) return [at];
  if (Array.isArray(value)) return value.flatMap((item, index) => unknownPaths(item, [...at, index]));

  return isRecord(value) ? Object.entries(value).flatMap(([key, item]) => unknownPaths(item, [...at, key])) : [];
}

/** A value the record holds itself, so a name like `toString` finds nothing rather than what every object inherits. */
export function own(values: Record<string, unknown>, name: string): unknown {
  return Object.hasOwn(values, name) ? values[name] : undefined;
}

/** What the steps lead to, or undefined where the value holds nothing there. */
export function valueAt(value: unknown, path: AttributePath): unknown {
  let at = value;

  for (const step of path)
    if (Array.isArray(at) && typeof step === 'number') at = at[step];
    else if (isRecord(at) && typeof step === 'string') at = own(at, step);
    else return undefined;

  return at;
}

/** A resource as state records it. Its address finds it; whatever its provider finds it by, an id among them, is one of its attributes. */
export interface Resource {
  resourceType: string;
  name: string;
  modulePath?: readonly ModuleStep[];
  key?: InstanceKey;
  attributes: Record<string, unknown>;
  /** Addresses of the resources this one reads from, kept so it can be deleted before them once the config drops it. */
  dependencies?: string[];
}

/** The state file. */
export interface State {
  version: number;
  /** Counts the writes. A saved plan records it, so a state written after the plan is caught. */
  serial: number;
  /** What the root module's outputs came to on the last run. */
  outputs?: Record<string, unknown>;
  resources: Record<string, Resource>;
}

/** The shape this version of Clay writes, bumped when it changes once a Clay is released. A state that names a higher one was written by a Clay that knows something this one does not. */
export const STATE_VERSION = 2;

export function emptyState(): State {
  return { version: STATE_VERSION, serial: 0, resources: {} };
}

/** What the engine goes on to read without asking: an address is built from the type, the name and the module path, the planner walks `attributes`, and the runner walks `dependencies`. */
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

/** An instance key names a resource or a module, as an address does, so it is a JavaScript number too. */
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

    // A step finds an entry by where it is filed, but a delete is built from what it holds.
    const held = Address.of(resource).toString();
    if (held !== address) say(`"${address}" holds ${held}`);
  }
}

/**
 * Resources as a file holds them, a state's or a plan's, read from JSON with every number exact: keys become JavaScript numbers, then each is checked for what the engine goes on to trust.
 * `field` names them when they are not a record, and `say` reports a problem as the file's reader words it.
 */
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

export type SchemaType = 'string' | 'number' | 'boolean' | 'list' | 'map' | 'object';

export interface SchemaDefinition {
  type: SchemaType;
  required?: boolean;
  forceNew?: boolean; // If true, a change to this attribute forces replacement (Delete -> Create)
  /** Made by the provider, and the configuration cannot set it unless `optional` says so. A plan with no change keeps it as read; a change makes it again unless it is `kept`. */
  computed?: boolean;
  /** With `computed`: the configuration may set it, and the provider makes it when the configuration does not. */
  optional?: boolean;
  /** With `computed`: made with the resource and the same until it is replaced, so a change in place keeps it as it was read. */
  kept?: boolean;
  elemType?: SchemaType; // For 'list' and 'map'
  schema?: Schema; // For 'object'
}

export type Schema = Record<string, SchemaDefinition>;

/** The steps from an attribute into what it holds: its name, then a key of a map or an index into a list. */
export type AttributePath = (string | number)[];

/** What a provider is asked to plan: a resource to create when `prior` is null, else one to change. */
export interface PlanRequest {
  /** The resource as the refresh read it. */
  prior: Record<string, unknown> | null;
  /** The configuration's values, with what the provider computed kept from `prior` where the configuration does not set it. */
  proposed: Record<string, unknown>;
  /** The configuration's values alone, so an optional computed value it sets can be told from one kept from `prior`. */
  config: Record<string, unknown>;
}

/** What a resource will hold once applied, as its provider plans it. */
export interface PlannedChange {
  /** Every value it will hold, UNKNOWN where only the apply makes one. A value the configuration sets stays as it is set. */
  after: Record<string, unknown>;
  /** Where a change replaces the resource rather than changing it in place. */
  replace: AttributePath[];
}

/** What a provider is asked to make. */
export interface CreateRequest {
  /** The configuration's values. */
  config: Record<string, unknown>;
  /** What the resource will hold, as the provider planned it at apply, UNKNOWN where only the apply makes a value. */
  planned: Record<string, unknown>;
}

/** What a provider is asked to change, with what it held so the provider can find it. */
export interface UpdateRequest extends CreateRequest {
  /** What state holds for it. */
  prior: Record<string, unknown>;
}

/**
 * A plan from the schema alone: with nothing changed the resource stays as it was read, and with anything changed, what the provider computes and the
 * configuration does not set is made again unless it is kept, and a changed `forceNew` attribute replaces it.
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

/** The engine's contract with a provider. A number in the inputs it is given arrives as an `ExactNumber`, never rounded. */
export interface Provider {
  /** The resource types it handles. */
  readonly resources: string[];

  /** The data source types it reads. A type may be both, as a file is written by one and read by the other. */
  readonly dataSources: string[];

  getSchema(type: string): Promise<Schema>;

  /** Throws when the inputs would not make a valid resource. */
  validate(type: string, inputs: Record<string, unknown>): Promise<void>;

  /** What the resource will hold once applied. `planFromSchema` plans from the schema alone. */
  plan(type: string, request: PlanRequest): Promise<PlannedChange>;

  /** The resource as it is now, found by what was last applied, or `null` when it is gone. */
  read(type: string, prior: Record<string, unknown>): Promise<Record<string, unknown> | null>;

  /** A data source type's names, apart from a resource's, since one type may be both and take different names as each. */
  getDataSourceSchema(type: string): Promise<Schema>;

  /** Throws when the inputs would not read a data source. */
  validateDataSource(type: string, inputs: Record<string, unknown>): Promise<void>;

  readDataSource(type: string, inputs: Record<string, unknown>): Promise<Record<string, unknown>>;

  /** The whole of the resource as made, what the provider computed included. */
  create(type: string, request: CreateRequest): Promise<Record<string, unknown>>;
  /** The whole of the resource as changed. */
  update(type: string, request: UpdateRequest): Promise<Record<string, unknown>>;
  delete(type: string, prior: Record<string, unknown>): Promise<void>;
}

/** One resource type's side of a provider. */
export interface ResourceHandler {
  getSchema(): Promise<Schema>;

  validate(inputs: Record<string, unknown>): Promise<void>;

  plan(request: PlanRequest): Promise<PlannedChange>;

  read(prior: Record<string, unknown>): Promise<Record<string, unknown> | null>;

  /** The whole of the resource as made. */
  create(request: CreateRequest): Promise<Record<string, unknown>>;

  /** The whole of the resource as changed. */
  update(request: UpdateRequest): Promise<Record<string, unknown>>;

  delete(prior: Record<string, unknown>): Promise<void>;
}

/** One data source type's side of a provider. */
export interface DataSourceHandler {
  getSchema(): Promise<Schema>;

  validate(inputs: Record<string, unknown>): Promise<void>;

  read(inputs: Record<string, unknown>): Promise<Record<string, unknown>>;
}
