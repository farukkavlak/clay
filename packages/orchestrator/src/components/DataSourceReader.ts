import { ModuleAddress, Schema } from '@clay/contracts';
import { DataBlock, spell } from '@clay/parser';

import { conformValues, writtenAt } from '../conformValues';
import { checkDataSourceGiven, checkDataSourceRead, heldBy } from '../providerResult';
import { ProviderRegistry } from '../ProviderRegistry';
import { withPlace } from '../place';
import { typedValues } from '../typed';
import { plainOf, Value, valueOf } from '../Value';

/** Asks a data source's provider for what it reads, given inputs already resolved. */
export class DataSourceReader {
  constructor(
    private providers: ProviderRegistry,
    // Loaded with the configuration, before any data source is read.
    private dataSchemas: Map<string, Schema>
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
      return { ...Object.fromEntries(leftOut), ...typedValues(schema, conformed), ...valued };
    } catch (error) {
      throw withPlace(error, writtenAt(error, stmt), spell(stmt), module);
    }
  }
}
