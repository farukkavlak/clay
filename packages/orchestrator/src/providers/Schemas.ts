import { Schema } from '@clay/provider';

/** The schemas of one kind, by type or name. A Map, since a type may be named `constructor`, which a plain object already has. */
export class SchemaTable {
  private readonly loaded = new Map<string, Schema>();

  constructor(private readonly kind: string) {}

  has(name: string): boolean {
    return this.loaded.has(name);
  }

  set(name: string, schema: Schema): void {
    this.loaded.set(name, schema);
  }

  /** Loaded with the configuration for each block that needs one, so a missing one is never the configuration's fault. */
  get(name: string): Schema {
    const schema = this.loaded.get(name);
    if (schema === undefined) throw new Error(`no schema is loaded for ${this.kind} "${name}", which is a bug`);

    return schema;
  }
}

/** What one run has loaded from its providers and provisioners. */
export class Schemas {
  readonly resources = new SchemaTable('resource type');
  readonly dataSources = new SchemaTable('data source type');
  readonly provisioners = new SchemaTable('provisioner');
  readonly configs = new SchemaTable('provider');
}
