import { isName, NAME_RULE, RESERVED_TYPES } from '@clay/contracts';

import { Header, Label } from '../body';
import { ConfigError } from '../ConfigError';

export interface LabelRule {
  missing: string;
  word: 'name' | 'type';
}

/** Names end up in addresses, which split on dots, so a name must be an identifier; a type cannot be a reference prefix either. */
function checked(label: Label, word: LabelRule['word']): string {
  if (!isName(label.value)) throw new ConfigError(`Invalid ${word} "${label.value}": a ${word} ${NAME_RULE}.`, label.position);
  if (word === 'type' && RESERVED_TYPES.has(label.value))
    throw new ConfigError(`"${label.value}" cannot be a type: a reference reads "${label.value}." as something else.`, label.position);

  return label.value;
}

/** The labels a block of its kind takes, in order; a missing one is refused where the `{` is, since one was looked for there. */
export function labelsOf(header: Header, rules: LabelRule[]): string[] {
  return rules.map((rule, index) => {
    const label = header.labels[index];
    if (label === undefined) throw new ConfigError(rule.missing, header.open);

    return checked(label, rule.word);
  });
}
