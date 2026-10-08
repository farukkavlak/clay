import { DataReference } from '@clay/parser';
import { Context, dataSourceKey, scopeOf } from '../keys';
import { Value } from '../Value';

export class DataSourceResolver {
  constructor(private dataSources: Map<string, Record<string, Value>>) {}

  resolve(reference: DataReference, context: Context): Value {
    const key = dataSourceKey(scopeOf(context), reference.type, reference.name);
    const attrName = reference.attribute;
    // No scope: the error's place names the module.
    const spelled = `data.${reference.type}.${reference.name}`;

    const dataAttributes = this.dataSources.get(key);
    if (!dataAttributes) throw new Error(`Data source "${spelled}" not found (or not resolved yet)`);

    // Plain indexing would find inherited names like `toString`.
    const attrValue = Object.hasOwn(dataAttributes, attrName) ? dataAttributes[attrName] : undefined;
    if (attrValue === undefined) throw new Error(`Attribute "${attrName}" not found on data source "${spelled}"`);

    return attrValue;
  }
}
