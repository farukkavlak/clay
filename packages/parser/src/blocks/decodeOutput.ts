import { OutputBlock } from '../ast';
import { Block } from '../body';
import { ConfigError } from '../ConfigError';
import { dependsOnOf } from './dependsOn';
import { typedBodyOf, TypedRules } from './typedBody';

export const outputRules = (name: string): TypedRules => ({ label: `Output "${name}"`, valueName: 'value', flag: 'sensitive', waits: true });

export function decodeOutput(block: Block, [name]: string[]): OutputBlock {
  const { attributes, declared, flagged } = typedBodyOf(block, outputRules(name));
  if (!attributes.value) throw new ConfigError(`Output "${name}" has no "value".`, block.position);

  return {
    type: 'Output',
    name,
    value: attributes.value,
    ...(declared && { valueType: declared.type }),
    ...(declared?.defaults && { defaults: declared.defaults }),
    ...(flagged && { sensitive: true }),
    ...(attributes.depends_on && { dependsOn: dependsOnOf(attributes.depends_on) }),
    position: block.position,
  };
}
