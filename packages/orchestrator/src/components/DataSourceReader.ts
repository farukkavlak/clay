import { AttributePath, Output, Schema, sensitiveUnder, UNKNOWN } from '@clay/contracts';
import { DataBlock, spell } from '@clay/parser';

import { conformed, writtenAt } from '../conformValues';
import { DataInstance } from '../keys';
import { checkDataSourceGiven, checkDataSourceRead, heldBy, hidingReason } from '../providerResult';
import { ProviderRegistry } from '../ProviderRegistry';
import { withPlace } from '../place';
import { marksOf, schemaRemarked } from '../schemaMarks';
import { typedValues } from '../typed';
import { plainOf, Value, valueOf, withSensitive } from '../Value';

/** A data source gives back, at an attribute it was given, the marks it was given with. */
function remarked(values: Record<string, Value>, given: Record<string, Value>): Record<string, Value> {
  return Object.fromEntries(Object.entries(values).map(([name, value]) => [name, withSensitive(value, Object.hasOwn(given, name) ? (given[name].sensitive ?? []) : [])]));
}

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
      const given = conformed(stmt.dataSourceType, schema, inputs);
      const config = plainOf(given);
      const sensitive = marksOf(schema, given);
      await hidingReason(stmt.dataSourceType, sensitive, () => provider.validateDataSource(stmt.dataSourceType, config));
      const read = await hidingReason(stmt.dataSourceType, sensitive, () => provider.readDataSource(stmt.dataSourceType, config), 'to read');
      const held = heldBy(stmt.dataSourceType, 'read', schema, read);
      checkDataSourceRead(stmt.dataSourceType, schema, plainOf(held));
      // A null reads as left out, so it never replaces what the configuration gave.
      const valued = Object.fromEntries(Object.entries(held).filter(([, value]) => value.data !== null));
      checkDataSourceGiven(stmt.dataSourceType, schema, config, plainOf(valued), sensitive);

      // A schema attribute neither the configuration nor the read gives is null.
      const leftOut = Object.entries(schema).map(([name, { type }]) => [name, valueOf(type, null)]);
      return this.keep(at, schemaRemarked(schema, remarked({ ...Object.fromEntries(leftOut), ...typedValues(schema, config), ...valued }, given)));
    } catch (error) {
      throw withPlace(error, writtenAt(error, stmt), spell(stmt), at);
    }
  }

  /** Not read now: what the configuration gives is known and checked, and the rest is unknown. */
  async defer(stmt: DataBlock, inputs: Record<string, Value>, at: DataInstance): Promise<Record<string, Value>> {
    const schema = this.dataSchemas.get(stmt.dataSourceType)!;

    try {
      const given = conformed(stmt.dataSourceType, schema, inputs);
      const config = plainOf(given);
      const provider = this.providers.reader(stmt.dataSourceType);
      await hidingReason(stmt.dataSourceType, marksOf(schema, given), () => provider.validateDataSource(stmt.dataSourceType, config));
      const later = Object.entries(schema).map(([name, { type }]) => [name, valueOf(type, UNKNOWN)]);
      return this.keep(at, schemaRemarked(schema, remarked({ ...Object.fromEntries(later), ...typedValues(schema, config) }, given)));
    } catch (error) {
      throw withPlace(error, writtenAt(error, stmt), spell(stmt), at);
    }
  }

  /** What a plan read, so the apply reads it no more, with the parts the plan found sensitive. */
  use(at: DataInstance, saved: Record<string, Output>, sensitive: readonly AttributePath[] = []): void {
    this.keep(at, Object.fromEntries(Object.entries(saved).map(([name, { type, value }]) => [name, withSensitive(valueOf(type, value), sensitiveUnder(sensitive, name))])));
  }

  /** By the instance's address, as a plan names it. */
  private keep(at: DataInstance, values: Record<string, Value>): Record<string, Value> {
    this.dataSources.set(at.toString(), values);
    return values;
  }
}
