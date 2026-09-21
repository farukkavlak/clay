import { Address } from '@clay/contracts';
import { dataSourceKey, scopeOf } from '../keys';
import { Resolver } from './Resolver';

export class DataSourceResolver implements Resolver {
  constructor(private dataSources: Map<string, Record<string, unknown>>) {}

  resolve(pathParts: string[], context: Address): unknown {
    if (pathParts.length < 4) throw new Error(`Data source reference must include attribute: ${pathParts.join('.')}`);

    const [, dataSourceType, dataSourceName, attrName] = pathParts;
    const key = dataSourceKey(scopeOf(context), dataSourceType, dataSourceName);

    const dataAttributes = this.dataSources.get(key);
    if (!dataAttributes) throw new Error(`Data source "${key}" not found (or not resolved yet)`);

    // Plain indexing would find inherited names like `toString`.
    const attrValue = Object.hasOwn(dataAttributes, attrName) ? dataAttributes[attrName] : undefined;
    if (attrValue === undefined) throw new Error(`Attribute "${attrName}" not found on data source "${key}"`);

    return attrValue;
  }
}
