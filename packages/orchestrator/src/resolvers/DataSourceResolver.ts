import { DataReference } from '@clay/parser';
import { Context, dataSourceKey, moduleOf, scopeOf } from '../keys';
import { Value } from '../Value';

export class DataSourceResolver {
  constructor(private dataSources: Map<string, Record<string, Value>>) {}

  resolve(reference: DataReference, context: Context): Value {
    // Keyed by the module as written, since a module with a data source has one instance.
    const key = dataSourceKey(scopeOf(moduleOf(context).withoutKeys()), reference.type, reference.name);
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
