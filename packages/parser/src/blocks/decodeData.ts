import { DataBlock } from '../ast';
import { Block } from '../body';
import { ConfigError } from '../ConfigError';
import { attributesIn } from './attributes';
import { dependsOnOf } from './dependsOn';

export function decodeData(block: Block, [dataSourceType, name]: string[]): DataBlock {
  const { count, for_each: forEach, depends_on: dependsOn, ...attributes } = attributesIn(block.body);
  if (count && forEach) throw new ConfigError(`data "${dataSourceType}" "${name}" has count or for_each, not both`, forEach.position);

  return {
    type: 'Data',
    dataSourceType,
    name,
    ...(count && { count }),
    ...(forEach && { forEach }),
    ...(dependsOn && { dependsOn: dependsOnOf(dependsOn) }),
    attributes,
    position: block.position,
  };
}
