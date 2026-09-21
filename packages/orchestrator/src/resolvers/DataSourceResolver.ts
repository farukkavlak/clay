import { Address } from '@clay/contracts';
import { dataSourceKey, scopeOf } from '../keys';
import { IResolver } from './IResolver';

export class DataSourceResolver implements IResolver {
  constructor(private dataSources: Map<string, Record<string, unknown>>) {}

  resolve(pathParts: string[], context: Address): unknown {
    if (pathParts.length < 4) throw new Error(`Data source reference must include attribute: ${pathParts.join('.')}`);

    const [, dataSourceType, dataSourceName, attrName] = pathParts;
    const key = dataSourceKey(scopeOf(context), dataSourceType, dataSourceName);

    const dataAttributes = this.dataSources.get(key);
    if (!dataAttributes) throw new Error(`Data source "${key}" not found (or not resolved yet)`);

    const attrValue = dataAttributes[attrName];
    if (attrValue === undefined) throw new Error(`Attribute "${attrName}" not found on data source "${key}"`);

    return attrValue;
  }
}
