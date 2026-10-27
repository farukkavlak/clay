import { containsUnknown, ExactNumber, memberKey } from '@clay/contracts';

/** Numbers by value, the rest by key. Only number keys start with `#`, so numbers stay together. */
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
 * Known members sorted and deduplicated, then null, then unknown members.
 * Unknown members are never deduplicated, since each may become any value, so the set's size is unknown until apply.
 */
export function setOf(members: readonly unknown[]): unknown[] {
  const known = members.filter((member) => member !== null && !containsUnknown(member));
  const once = new Map(known.map((member) => [memberKey(member), member]));
  const nulls = members.includes(null) ? [null] : [];

  return [...inOrder([...once.values()]), ...nulls, ...inOrder(members.filter((member) => containsUnknown(member)))];
}
