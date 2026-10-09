import { DataReference, Position, Step } from '@clay/parser';
import { Context, dataSourceKey, scopeOf } from '../keys';
import { objectOf, Value } from '../Value';
import { readInstance } from './instance';

export class DataSourceResolver {
  constructor(private dataSources: Map<string, Record<string, Value>>) {}

  /** Returns the attribute and the steps still to take into it, or the whole data source where the reference names no attribute. */
  resolve(reference: DataReference, context: Context, position?: Position): { value: Value; path: Step[] } {
    const key = dataSourceKey(scopeOf(context), reference.type, reference.name);
    // No scope: the error's place names the module.
    const spelled = `data.${reference.type}.${reference.name}`;
    const { attribute, path } = readInstance(spelled, reference.path, undefined, position);

    const dataAttributes = this.dataSources.get(key);
    if (!dataAttributes) throw new Error(`Data source "${spelled}" not found (or not resolved yet)`);
    if (attribute === undefined) return { value: objectOf(Object.entries(dataAttributes)), path };

    // Plain indexing would find inherited names like `toString`.
    const attrValue = Object.hasOwn(dataAttributes, attribute) ? dataAttributes[attribute] : undefined;
    if (attrValue === undefined) throw new Error(`Attribute "${attribute}" not found on data source "${spelled}"`);

    return { value: attrValue, path };
  }
}
