import { containsUnknown, ExactNumber, isRecord, isUnknown, Schema, SchemaDefinition, UNKNOWN } from '@clay/contracts';

/** One text per value, so two members are the same exactly when their texts are; a string is quoted, so none spells a number. */
function memberKey(value: unknown): string {
  if (value instanceof ExactNumber) return `#${value.toString()}`;
  if (Array.isArray(value)) return `[${value.map((item) => memberKey(item)).join(',')}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${memberKey(value[key])}`)
      .join(',')}}`;

  // A provider may hand back `undefined`, which JSON has no text for.
  return String(JSON.stringify(value));
}

/** Numbers by their value, anything else by its key. Every number's key starts with `#`, as no other key does, so the numbers stay together among the rest. */
function byMember([leftKey, left]: [string, unknown], [rightKey, right]: [string, unknown]): number {
  if (left instanceof ExactNumber && right instanceof ExactNumber) return left.compare(right);

  return leftKey < rightKey ? -1 : 1;
}

/** A member not known yet may turn out the same as another, so neither how many there are nor their order is known. */
function asSet(members: unknown[]): unknown {
  if (members.some((member) => containsUnknown(member))) return UNKNOWN;

  const byKey = new Map(members.map((member) => [memberKey(member), member]));
  return [...byKey].sort(byMember).map(([, member]) => member);
}

function definitionIn(schema: Schema, name: string): SchemaDefinition | undefined {
  return Object.hasOwn(schema, name) ? schema[name] : undefined;
}

type Order = (definition: SchemaDefinition | undefined, value: unknown) => unknown;

function entriesOrdered(value: Record<string, unknown>, definitionOf: (name: string) => SchemaDefinition | undefined, order: Order): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, order(definitionOf(name), item)]));
}

function itemsOrdered({ type, schema, elemType }: SchemaDefinition, value: unknown, order: Order): unknown {
  const item = elemType && { type: elemType };
  if (Array.isArray(value)) return item ? value.map((member) => order(item, member)) : value;
  if (!isRecord(value)) return value;
  if (type === 'object') return schema ? entriesOrdered(value, (name) => definitionIn(schema, name), order) : value;

  return item ? entriesOrdered(value, () => item, order) : value;
}

function ordered(definition: SchemaDefinition | undefined, value: unknown): unknown {
  if (!definition || isUnknown(value)) return value;

  const items = itemsOrdered(definition, value, ordered);
  return definition.type === 'set' && Array.isArray(items) ? asSet(items) : items;
}

/** Each set in the values, however deep, in one order and with each member once, so two that hold the same members compare equal. */
export function setsOrdered(schema: Schema, values: Record<string, unknown>): Record<string, unknown> {
  return entriesOrdered(values, (name) => definitionIn(schema, name), ordered);
}
