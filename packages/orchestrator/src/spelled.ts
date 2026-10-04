import { AttributePath } from '@clay/contracts';

/** A path as the configuration would write it: `tags["a"][0]`. */
export function spelled(path: AttributePath): string {
  const [name, ...steps] = path;

  return String(name) + steps.map((step) => `[${JSON.stringify(step)}]`).join('');
}

/** A count as a message says it: `1 item`, `2 items`. */
export function items(count: number): string {
  return `${count} ${count === 1 ? 'item' : 'items'}`;
}
