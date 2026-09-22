import { Address } from '@clay/contracts';
import { DataReference } from '@clay/parser';
import { dataSourceKey, scopeOf } from '../keys';

export class DataSourceResolver {
  constructor(private dataSources: Map<string, Record<string, unknown>>) {}

  resolve(reference: DataReference, context: Address): unknown {
    const key = dataSourceKey(scopeOf(context), reference.type, reference.name);
    const attrName = reference.attribute;

    const dataAttributes = this.dataSources.get(key);
    if (!dataAttributes) throw new Error(`Data source "${key}" not found (or not resolved yet)`);

    // Plain indexing would find inherited names like `toString`.
    const attrValue = Object.hasOwn(dataAttributes, attrName) ? dataAttributes[attrName] : undefined;
    if (attrValue === undefined) throw new Error(`Attribute "${attrName}" not found on data source "${key}"`);

    return attrValue;
  }
}
