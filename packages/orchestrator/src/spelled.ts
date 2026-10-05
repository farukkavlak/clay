import { AttributePath } from '@clay/contracts';

/** `tags["a"][0]`. */
export function spelled(path: AttributePath): string {
  const [name, ...steps] = path;

  return String(name) + steps.map((step) => `[${JSON.stringify(step)}]`).join('');
}

export function items(count: number): string {
  return `${count} ${count === 1 ? 'item' : 'items'}`;
}
