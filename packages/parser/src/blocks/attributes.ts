import { AttributeValue } from '../ast';
import { Attribute, Block, Body, Header } from '../body';
import { ConfigError } from '../ConfigError';

/** A block where none is taken is refused where its `=` was looked for, after its name. */
export function refuseBlock(header: Header, message = "Expect '=' after attribute name."): never {
  throw new ConfigError(message, header.labels[0]?.position ?? header.open);
}

/** The attributes by name, which the schema let in once each; each block it let in is handed to `onBlock`, in the order written. */
export function attributesIn(body: Body, onBlock?: (block: Block) => void): Record<string, AttributeValue> {
  const attributes: Record<string, AttributeValue> = {};
  for (const item of body)
    if (item.type === 'Block') onBlock?.(item);
    else attributes[item.name] = item.value;

  return attributes;
}

/** The attributes of a body the schema let no block into. */
export function attributesOnly(body: Body): Attribute[] {
  return body.filter((item): item is Attribute => item.type === 'Attribute');
}

/** Read with the block, before any reference has a value, so it is written out. */
export function flagOf(value: AttributeValue, name: string): boolean {
  if (value.type !== 'Boolean') throw new ConfigError(`${name} is true or false.`, value.position);

  return value.value;
}
