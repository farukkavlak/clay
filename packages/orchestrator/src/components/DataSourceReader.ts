import { ModuleAddress, Output, Schema, UNKNOWN } from '@clay/contracts';
import { DataBlock, spell } from '@clay/parser';

import { conformValues, writtenAt } from '../conformValues';
import { dataSourceKey, scopeOf } from '../keys';
import { checkDataSourceGiven, checkDataSourceRead, heldBy } from '../providerResult';
import { ProviderRegistry } from '../ProviderRegistry';
import { withPlace } from '../place';
import { typedValues } from '../typed';
import { plainOf, Value, valueOf } from '../Value';

/** Asks a data source's provider for what it reads, and keeps it where references find it. */
export class DataSourceReader {
  constructor(
    private providers: ProviderRegistry,
    // Loaded with the configuration, before any data source is read.
    private dataSchemas: Map<string, Schema>,
    private dataSources: Map<string, Record<string, Value>>
  ) {}

  async read(stmt: DataBlock, inputs: Record<string, Value>, module: ModuleAddress): Promise<Record<string, Value>> {
    const schema = this.dataSchemas.get(stmt.dataSourceType)!;

    try {
      const provider = this.providers.reader(stmt.dataSourceType);
      const conformed = conformValues(stmt.dataSourceType, schema, inputs);
      await provider.validateDataSource(stmt.dataSourceType, conformed);
      const read = await provider.readDataSource(stmt.dataSourceType, conformed);
      const held = heldBy(stmt.dataSourceType, 'read', schema, read);
      checkDataSourceRead(stmt.dataSourceType, schema, plainOf(held));
      // A null reads as left out, so it never replaces what the configuration gave.
      const valued = Object.fromEntries(Object.entries(held).filter(([, value]) => value.data !== null));
      checkDataSourceGiven(stmt.dataSourceType, schema, conformed, plainOf(valued));

      // A schema attribute neither the configuration nor the read gives is null.
      const leftOut = Object.entries(schema).map(([name, { type }]) => [name, valueOf(type, null)]);
      return this.keep(stmt, module, { ...Object.fromEntries(leftOut), ...typedValues(schema, conformed), ...valued });
    } catch (error) {
      throw withPlace(error, writtenAt(error, stmt), spell(stmt), module);
    }
  }

  /** Read at apply: what the configuration gives is known now, and the rest is unknown. */
  defer(stmt: DataBlock, inputs: Record<string, Value>, module: ModuleAddress): Record<string, Value> {
    const schema = this.dataSchemas.get(stmt.dataSourceType)!;

    try {
      const conformed = conformValues(stmt.dataSourceType, schema, inputs);
      const later = Object.entries(schema).map(([name, { type }]) => [name, valueOf(type, UNKNOWN)]);
      return this.keep(stmt, module, { ...Object.fromEntries(later), ...typedValues(schema, conformed) });
    } catch (error) {
      throw withPlace(error, writtenAt(error, stmt), spell(stmt), module);
    }
  }

  /** What a plan read, so the apply reads it no more. */
  use(stmt: DataBlock, module: ModuleAddress, saved: Record<string, Output>): void {
    this.keep(stmt, module, Object.fromEntries(Object.entries(saved).map(([name, { type, value }]) => [name, valueOf(type, value)])));
  }

  private keep(stmt: DataBlock, module: ModuleAddress, values: Record<string, Value>): Record<string, Value> {
    this.dataSources.set(dataSourceKey(scopeOf(module), stmt.dataSourceType, stmt.name), values);
    return values;
  }
}
