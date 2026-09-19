/** Represents a resource definition from the parser (Code -> AST) */
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

export type SchemaType = 'string' | 'number' | 'boolean' | 'list' | 'map' | 'object';

export interface ISchemaDefinition {
  type: SchemaType;
  required?: boolean;
  forceNew?: boolean; // If true, a change to this attribute forces replacement (Delete -> Create)
  elemType?: SchemaType; // For 'list' and 'map'
  schema?: ISchema; // For 'object'
}

export type ISchema = Record<string, ISchemaDefinition>;

/** The contract that ALL providers must implement */
export interface IProvider {
  /** Resource types handled by this provider (e.g., ['custom_resource', 'another_type']) */
  readonly resources: string[];

  /** Returns the schema for a specific resource type */
  getSchema(type: string): Promise<ISchema>;

  /** Validates inputs against the resource schema. Throws validation error if invalid. */
  validate(type: string, inputs: Record<string, unknown>): Promise<void>;

  /**
   * Read a data source
   */
  read(type: string, inputs: Record<string, unknown>): Promise<Record<string, unknown>>;

  create(type: string, inputs: Record<string, unknown>): Promise<string>;
  update(id: string, type: string, inputs: Record<string, unknown>): Promise<void>;
  delete(id: string, type: string): Promise<void>;
}

/**
 * Resource Handler Interface
 * Each resource type (e.g., local_file, aws_s3_bucket) implements this interface
 */
export interface IResourceHandler {
  /**
   * Returns the schema for this resource
   */
  getSchema(): Promise<ISchema>;

  /**
   * Validate resource inputs before creation/update
   */
  validate(inputs: Record<string, unknown>): Promise<void>;

  /**
   * Read a data source
   */
  read(inputs: Record<string, unknown>): Promise<Record<string, unknown>>;

  /**
   * Create a new resource
   * @returns Resource ID (e.g., file path, AWS ARN)
   */
  create(inputs: Record<string, unknown>): Promise<string>;

  /**
   * Update an existing resource
   */
  update(id: string, inputs: Record<string, unknown>): Promise<void>;

  /**
   * Delete a resource
   */
  delete(id: string): Promise<void>;
}
