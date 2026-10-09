import { InstanceKey, Schema } from '@clay/contracts';
import { DataReference, Position, Step } from '@clay/parser';

import { Instances, Repetition } from '../Instances';
import { Context, dataSourceAddress, dataSourceKey, moduleOf, scopeOf } from '../keys';
import { objectOf, plainOf, Value, valueOf } from '../Value';
import { everyType, readInstance } from './instance';

export class DataSourceResolver {
  constructor(
    private dataSources: Map<string, Record<string, Value>>,
    // Loaded with the configuration, before any data source is read.
    private dataSchemas: Map<string, Schema>,
    private instances: Instances
  ) {}

  /** Returns the attribute and the steps still to take into it, the whole instance where the reference names no attribute, or every instance where it names no instance. */
  resolve(reference: DataReference, context: Context, position?: Position): { value: Value; path: Step[] } {
    const module = moduleOf(context);
    // No scope: the error's place names the module.
    const spelled = `data.${reference.type}.${reference.name}`;
    const repetition = this.instances.repetitionOf(dataSourceKey(scopeOf(module.withoutKeys()), reference.type, reference.name));
    const { every, key, attribute, path } = readInstance(spelled, reference.path, repetition, position);
    if (every) return { value: this.every(reference, scopeOf(module), every, spelled), path };

    const dataAttributes = this.read(reference, scopeOf(module), key, spelled);
    if (attribute === undefined) return { value: objectOf(Object.entries(dataAttributes)), path };

    // Plain indexing would find inherited names like `toString`.
    const attrValue = Object.hasOwn(dataAttributes, attribute) ? dataAttributes[attribute] : undefined;
    if (attrValue === undefined) throw new Error(`Attribute "${attribute}" not found on data source "${spelled}"`);

    return { value: attrValue, path };
  }

  /** The graph reads its count before anything that reads it. */
  private every(reference: DataReference, scope: string, repetition: Repetition, spelled: string): Value {
    // The graph has already refused undeclared data sources, and every one has its schema.
    const type = everyType(repetition, this.dataSchemas.get(reference.type)!);
    const keys = this.instances.keysOf(dataSourceKey(scope, reference.type, reference.name));
    if (keys === undefined) throw new Error(`${spelled} was read before its ${repetition}`);

    return valueOf(
      type,
      keys.map((key) => plainOf(this.read(reference, scope, key, spelled)))
    );
  }

  private read(reference: DataReference, scope: string, key: InstanceKey | undefined, spelled: string): Record<string, Value> {
    const values = this.dataSources.get(dataSourceAddress(scope, reference.type, reference.name, key));
    if (!values) throw new Error(`Data source "${spelled}" not found (or not resolved yet)`);

    return values;
  }
}
