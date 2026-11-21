import { Schema } from '@clay/provider';

import { Schemas, SchemaTable } from '../src/providers/Schemas';

type Loaded = Iterable<readonly [string, Schema]>;

/** A table loaded with the schemas given, by type or name. */
export function tableOf(loaded: Loaded = [], kind = 'resource type'): SchemaTable {
  const table = new SchemaTable(kind);
  for (const [name, schema] of loaded) table.set(name, schema);

  return table;
}

/** A run's schemas, with the resource and data source ones given. */
export function schemasOf(resources: Loaded = [], dataSources: Loaded = []): Schemas {
  const schemas = new Schemas();
  for (const [name, schema] of resources) schemas.resources.set(name, schema);
  for (const [name, schema] of dataSources) schemas.dataSources.set(name, schema);

  return schemas;
}
