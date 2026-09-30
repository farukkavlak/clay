import type { InstanceKey, ModuleStep } from './Address';

export { Address, isInstanceKey, isModulePath, ModuleAddress } from './Address';
export type { InstanceKey, ModuleStep } from './Address';
export { ExactNumber, NumberError } from './ExactNumber';

/** A plain object, as JSON makes one: a number read from a file is an ExactNumber, which is no record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;

  const prototype: unknown = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}

/** A resource as state records it. */
export interface Resource {
  id?: string;
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
export const STATE_VERSION = 1;

export function emptyState(): State {
  return { version: STATE_VERSION, serial: 0, resources: {} };
}

export type SchemaType = 'string' | 'number' | 'boolean' | 'list' | 'map' | 'object';

export interface SchemaDefinition {
  type: SchemaType;
  required?: boolean;
  forceNew?: boolean; // If true, a change to this attribute forces replacement (Delete -> Create)
  elemType?: SchemaType; // For 'list' and 'map'
  schema?: Schema; // For 'object'
}

export type Schema = Record<string, SchemaDefinition>;

/** The engine's contract with a provider. A number in the inputs it is given arrives as an `ExactNumber`, never rounded. */
export interface Provider {
  /** The resource types it handles. */
  readonly resources: string[];

  /** The data source types it reads. A type may be both, as a file is written by one and read by the other. */
  readonly dataSources: string[];

  getSchema(type: string): Promise<Schema>;

  /** Throws when the inputs would not make a valid resource. */
  validate(type: string, inputs: Record<string, unknown>): Promise<void>;

  /** Throws when the inputs would not read a data source. */
  validateDataSource(type: string, inputs: Record<string, unknown>): Promise<void>;

  readDataSource(type: string, inputs: Record<string, unknown>): Promise<Record<string, unknown>>;

  create(type: string, inputs: Record<string, unknown>): Promise<string>;
  update(id: string, type: string, inputs: Record<string, unknown>): Promise<void>;
  delete(id: string, type: string): Promise<void>;
}

/** One resource type's side of a provider. */
export interface ResourceHandler {
  getSchema(): Promise<Schema>;

  validate(inputs: Record<string, unknown>): Promise<void>;

  /** Returns the id the resource is known by from now on. */
  create(inputs: Record<string, unknown>): Promise<string>;

  update(id: string, inputs: Record<string, unknown>): Promise<void>;

  delete(id: string): Promise<void>;
}

/** One data source type's side of a provider. */
export interface DataSourceHandler {
  validate(inputs: Record<string, unknown>): Promise<void>;

  read(inputs: Record<string, unknown>): Promise<Record<string, unknown>>;
}
