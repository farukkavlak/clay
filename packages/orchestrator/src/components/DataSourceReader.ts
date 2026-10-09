import { Output, Schema, UNKNOWN } from '@clay/contracts';
import { DataBlock, spell } from '@clay/parser';

import { conformValues, writtenAt } from '../conformValues';
import { DataInstance } from '../keys';
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

  async read(stmt: DataBlock, inputs: Record<string, Value>, at: DataInstance): Promise<Record<string, Value>> {
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
      return this.keep(at, { ...Object.fromEntries(leftOut), ...typedValues(schema, conformed), ...valued });
    } catch (error) {
      throw withPlace(error, writtenAt(error, stmt), spell(stmt), at);
    }
  }

  /** Read at apply: what the configuration gives is known now, and the rest is unknown. */
  defer(stmt: DataBlock, inputs: Record<string, Value>, at: DataInstance): Record<string, Value> {
    const schema = this.dataSchemas.get(stmt.dataSourceType)!;

    try {
      const conformed = conformValues(stmt.dataSourceType, schema, inputs);
      const later = Object.entries(schema).map(([name, { type }]) => [name, valueOf(type, UNKNOWN)]);
      return this.keep(at, { ...Object.fromEntries(later), ...typedValues(schema, conformed) });
    } catch (error) {
      throw withPlace(error, writtenAt(error, stmt), spell(stmt), at);
    }
  }

  /** What a plan read, so the apply reads it no more. */
  use(at: DataInstance, saved: Record<string, Output>): void {
    this.keep(at, Object.fromEntries(Object.entries(saved).map(([name, { type, value }]) => [name, valueOf(type, value)])));
  }

  /** By the instance's address, as a plan names it. */
  private keep(at: DataInstance, values: Record<string, Value>): Record<string, Value> {
    this.dataSources.set(at.toString(), values);
    return values;
  }
}
