import { AttributePath } from '@clay/contracts';

/** A path as the configuration would write it: `tags["a"][0]`. */
export function spelled(path: AttributePath): string {
  const [name, ...steps] = path;

  return String(name) + steps.map((step) => `[${JSON.stringify(step)}]`).join('');
}
