import { containsUnknown, ExactNumber, isRecord, isUnknown } from '@clay/contracts';

/** One text per value, so two members are the same exactly when their texts are; a string is quoted, so none spells a number or a value not known yet. */
function memberKey(value: unknown): string {
  if (value instanceof ExactNumber) return `#${value.toString()}`;
  if (isUnknown(value)) return '?';
  // A set inside a member was put in order first, so the same members give the same text.
  if (Array.isArray(value)) return `[${value.map((item) => memberKey(item)).join(',')}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${memberKey(value[key])}`)
      .join(',')}}`;

  return JSON.stringify(value);
}

/** Numbers by their value, anything else by its key. Every number's key starts with `#`, as no other key does, so the numbers stay together among the rest. */
function byMember([leftKey, left]: [string, unknown], [rightKey, right]: [string, unknown]): number {
  if (left instanceof ExactNumber && right instanceof ExactNumber) return left.compare(right);

  return leftKey < rightKey ? -1 : Number(leftKey > rightKey);
}

function inOrder(members: readonly unknown[]): unknown[] {
  return members
    .map((member): [string, unknown] => [memberKey(member), member])
    .sort(byMember)
    .map(([, member]) => member);
}

/**
 * A set's members in one order: the known ones by value and each once, then null, then those not known yet by what is known of them.
 * A member not known yet may turn out to be any value, another member's too, so none is taken for another and the set's size is not known until the apply.
 */
export function setOf(members: readonly unknown[]): unknown[] {
  const known = members.filter((member) => member !== null && !containsUnknown(member));
  const once = new Map(known.map((member) => [memberKey(member), member]));
  const nulls = members.includes(null) ? [null] : [];

  return [...inOrder([...once.values()]), ...nulls, ...inOrder(members.filter((member) => containsUnknown(member)))];
}
