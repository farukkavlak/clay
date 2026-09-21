export { Address } from './Address';

/** A resource as state records it. */
export interface IResource {
  id?: string;
  type: string;
  resourceType: string;
  name: string;
  modulePath?: string[];
  attributes: Record<string, unknown>;
  /** Addresses of the resources this one reads from, kept so it can be deleted before them once the config drops it. */
  dependencies?: string[];
}

/** The state file. */
export interface IState {
  version: number;
  /** Counts the writes. A saved plan records it, so a state written after the plan is caught. */
  serial: number;
  /** What the root module's outputs came to on the last run. */
  outputs?: Record<string, unknown>;
  resources: Record<string, IResource>;
}

export function emptyState(): IState {
  return { version: 1, serial: 0, resources: {} };
}

export type SchemaType = 'string' | 'number' | 'boolean' | 'list' | 'map' | 'object';

export interface ISchemaDefinition {
  type: SchemaType;
  required?: boolean;
  forceNew?: boolean; // If true, a change to this attribute forces replacement (Delete -> Create)
  elemType?: SchemaType; // For 'list' and 'map'
  schema?: ISchema; // For 'object'
}

export type ISchema = Record<string, ISchemaDefinition>;

/** The engine's contract with a provider. */
export interface IProvider {
  /** The resource types it handles. */
  readonly resources: string[];

  getSchema(type: string): Promise<ISchema>;

  /** Throws when the inputs would not make a valid resource. */
  validate(type: string, inputs: Record<string, unknown>): Promise<void>;

  read(type: string, inputs: Record<string, unknown>): Promise<Record<string, unknown>>;

  create(type: string, inputs: Record<string, unknown>): Promise<string>;
  update(id: string, type: string, inputs: Record<string, unknown>): Promise<void>;
  delete(id: string, type: string): Promise<void>;
}

/** One resource type's side of a provider. */
export interface IResourceHandler {
  getSchema(): Promise<ISchema>;

  validate(inputs: Record<string, unknown>): Promise<void>;

  read(inputs: Record<string, unknown>): Promise<Record<string, unknown>>;

  /** Returns the id the resource is known by from now on. */
  create(inputs: Record<string, unknown>): Promise<string>;

  update(id: string, inputs: Record<string, unknown>): Promise<void>;

  delete(id: string): Promise<void>;
}
