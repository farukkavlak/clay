import { AttributeValue, Validation } from '../ast';
import { Block, Header } from '../body';
import { ConfigError } from '../ConfigError';
import { decodeType, ParsedType } from '../decodeType';
import { flagOf, refuseBlock } from './attributes';
import { decodeValidation } from './decodeValidation';

/** What a variable's or an output's block takes: the one value, `type`, the flag, a description, and `validation` blocks or `depends_on` where `variable` or `waits` says. */
export interface TypedRules {
  /** How a message names the block, as `Variable "v"`. */
  label: string;
  valueName: string;
  flag: string;
  variable?: string;
  waits?: true;
}

export interface TypedBody {
  attributes: Record<string, AttributeValue>;
  declared?: ParsedType;
  flagged?: boolean;
  validations: Validation[];
}

/** Read by people only, so it is checked and dropped. */
function checkDescription(value: AttributeValue): void {
  if (value.type !== 'String') throw new ConfigError('A description is plain text, in quotes or a heredoc, with no ${...}', value.position);
}

function takenBy({ label, valueName, flag, waits }: TypedRules): string {
  const names = [valueName, 'type', flag, 'description', ...(waits ? ['depends_on'] : [])].map((name) => `"${name}"`);

  return `${label} takes only ${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** A block in a variable's or an output's body, refused unless it is a variable's `validation`. */
export function checkTypedBlock(inner: Header, { label, variable }: TypedRules): void {
  if (variable !== undefined && inner.name === 'validation') {
    if (inner.labels.length > 0) refuseBlock(inner, "Expect '{' after validation.");
    return;
  }

  if (inner.labels.length > 0) refuseBlock(inner);
  throw new ConfigError(`${label} takes ${variable === undefined ? 'no blocks' : 'only validation blocks'}, not a "${inner.name}" block.`, inner.position);
}

/** What one attribute gives the block; checked as it is read, and again when the block is. Any other name is refused, since nothing would read it. */
export function typedAttribute(name: string, value: AttributeValue, rules: TypedRules): Partial<TypedBody> {
  switch (name) {
    case 'type': {
      return { declared: decodeType(value) };
    }
    case rules.flag: {
      return { flagged: flagOf(value, name) };
    }
    case 'description': {
      checkDescription(value);
      return {};
    }
    default: {
      if (name === rules.valueName || (rules.waits && name === 'depends_on')) return { attributes: { [name]: value } };
      throw new ConfigError(`${takenBy(rules)}, not "${name}".`, value.position);
    }
  }
}

export function typedBodyOf(block: Block, rules: TypedRules): TypedBody {
  const body: TypedBody = { attributes: {}, validations: [] };
  for (const item of block.body)
    if (item.type === 'Attribute') {
      const { attributes, ...given } = typedAttribute(item.name, item.value, rules);
      Object.assign(body, given);
      Object.assign(body.attributes, attributes);
    }
    // The schema let only a variable's validation blocks through.
    else if (rules.variable !== undefined) body.validations.push(decodeValidation(item, rules.variable));

  return body;
}
