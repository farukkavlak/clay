/** Throws when state has lost the id, since nothing else finds the resource. */
export function idOf(prior: Record<string, unknown>): string {
  if (typeof prior.id !== 'string') throw new Error('the resource holds no id to find it by');

  return prior.id;
}
