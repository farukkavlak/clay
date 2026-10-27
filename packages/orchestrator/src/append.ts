/** Adds to the list in place, so a list built one item at a time is not copied for each. */
export function append<K, V>(lists: Map<K, V[]>, key: K, value: V): void {
  const list = lists.get(key);
  if (list) list.push(value);
  else lists.set(key, [value]);
}
