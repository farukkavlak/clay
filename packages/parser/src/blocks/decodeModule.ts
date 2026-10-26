import { ModuleBlock } from '../ast';
import { Block } from '../body';
import { ConfigError } from '../ConfigError';
import { attributesIn } from './attributes';
import { dependsOnOf } from './dependsOn';

export function decodeModule(block: Block, [name]: string[]): ModuleBlock {
  const { count, for_each: forEach, depends_on: dependsOn, ...attributes } = attributesIn(block.body);
  if (count && forEach) throw new ConfigError(`module "${name}" has count or for_each, not both`, forEach.position);

  return {
    type: 'Module',
    name,
    ...(count && { count }),
    ...(forEach && { forEach }),
    ...(dependsOn && { dependsOn: dependsOnOf(dependsOn) }),
    attributes,
    position: block.position,
  };
}
