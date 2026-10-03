import { containsUnknown, ExactNumber, isRecord, isUnknown, Schema, Type, UNKNOWN } from '@clay/contracts';

import { SetValue } from './SetValue';

/** One text per value, so two members are the same exactly when their texts are; a string is quoted, so none spells a number. */
function memberKey(value: unknown): string {
  if (value instanceof ExactNumber) return `#${value.toString()}`;
  // An inner set is marked before the set around it is ordered.
  if (value instanceof SetValue) return memberKey(value.members);
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

function typeIn(schema: Schema, name: string): Type | undefined {
  return Object.hasOwn(schema, name) ? schema[name].type : undefined;
}

type Order = (type: Type | undefined, value: unknown) => unknown;

function entriesOrdered(value: Record<string, unknown>, typeOf: (name: string) => Type | undefined, order: Order): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, order(typeOf(name), item)]));
}

function listOrdered(type: Type, value: unknown[], order: Order): unknown[] {
  if (type.kind === 'tuple') return value.map((item, index) => order(type.elements[index], item));

  return type.kind === 'list' || type.kind === 'set' ? value.map((member) => order(type.element, member)) : value;
}

function itemsOrdered(type: Type, value: unknown, order: Order): unknown {
  if (Array.isArray(value)) return listOrdered(type, value, order);
  if (!isRecord(value)) return value;
  if (type.kind === 'object') return entriesOrdered(value, (name) => (Object.hasOwn(type.attributes, name) ? type.attributes[name] : undefined), order);

  return type.kind === 'map' ? entriesOrdered(value, () => type.element, order) : value;
}

/** How a set ends up once its members are in order: a list for a provider, a plan and a state, a `SetValue` for the configuration to read. */
type Finish = (members: unknown[]) => unknown;

function ordered(type: Type | undefined, value: unknown, finish: Finish): unknown {
  if (!type || isUnknown(value)) return value;

  const items = itemsOrdered(type, value, (held, item) => ordered(held, item, finish));
  if (type.kind !== 'set' || !Array.isArray(items)) return items;

  const set = asSet(items);
  return Array.isArray(set) ? finish(set) : set;
}

/** Each set in the values, however deep, in one order and with each member once, so two that hold the same members compare equal. */
export function setsOrdered(schema: Schema, values: Record<string, unknown>): Record<string, unknown> {
  return entriesOrdered(
    values,
    (name) => typeIn(schema, name),
    (type, value) => ordered(type, value, (members) => members)
  );
}

/** The values as the configuration reads them, with each set in them, however deep, a `SetValue`. */
export function setsMarked(schema: Schema, values: Record<string, unknown>): Record<string, unknown> {
  return entriesOrdered(
    values,
    (name) => typeIn(schema, name),
    (type, value) => ordered(type, value, (members) => new SetValue(members))
  );
}
