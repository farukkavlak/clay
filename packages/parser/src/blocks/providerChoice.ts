import { isName, NAME_RULE } from '@clay/core';

import { AttributeValue, Label, ProviderChoice, ProviderPass } from '../ast';
import { ConfigError } from '../ConfigError';

const CHOICE = 'provider names a provider and, for a second instance, its alias, as in provider = local.west';

/** Written out, since which provider is configured is known before any value is. */
export function readAlias(value: AttributeValue): Label {
  if (value.type !== 'String') throw new ConfigError('alias is a name in quotes, as in alias = "west"', value.position);
  if (!isName(value.value)) throw new ConfigError(`Invalid alias "${value.value}": an alias ${NAME_RULE}.`, value.position);

  return { value: value.value, position: value.position };
}

export function providerChoiceOf(value: AttributeValue, rule = CHOICE): ProviderChoice {
  if (value.type !== 'Reference' || value.value.length > 2) throw new ConfigError(rule, value.position);

  const names = value.value.map((step) => ('name' in step ? step.name : undefined));
  const [name, alias] = names;
  if (name === undefined || (names.length === 2 && alias === undefined)) throw new ConfigError(rule, value.position);

  return { name, ...(alias !== undefined && { alias }), position: value.position };
}

const PASSES = 'providers maps a provider of the module to an instance of the caller, as in providers = { local = local.west }';

/** Written out, as `provider` is, so which instance a module's block takes is known before any value is. */
export function providerPassesOf(value: AttributeValue): ProviderPass[] {
  if (value.type !== 'Map') throw new ConfigError(PASSES, value.position);

  return Object.entries(value.value).map(([name, written]) => {
    const { position, quoted } = value.keys[name];
    if (quoted) throw new ConfigError('providers names each provider without quotes', position);

    const to = providerChoiceOf(written, PASSES);
    if (to.name !== name) throw new ConfigError(`providers gives provider "${name}" an instance of provider "${to.name}"`, written.position);

    return { name, to, position };
  });
}
