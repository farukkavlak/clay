/** A resource is found by the id it was made with; state that lost it has nothing to find. */
export function idOf(prior: Record<string, unknown>): string {
  if (typeof prior.id !== 'string') throw new Error('the resource holds no id to find it by');

  return prior.id;
}
