import { Type } from '@clay/contracts';
import { NAME } from '@clay/parser';

function attribute(name: string, spelled: string, optional: boolean): string {
  return `${NAME.test(name) ? name : JSON.stringify(name)} = ${optional ? `optional(${spelled})` : spelled}`;
}

/** As a configuration writes it: `set(string)`, `object({ a = string, b = optional(number) })`. */
export function typeName(type: Type): string {
  if (type.kind === 'list' || type.kind === 'set' || type.kind === 'map') return `${type.kind}(${typeName(type.element)})`;
  if (type.kind === 'tuple') return `tuple([${type.elements.map((element) => typeName(element)).join(', ')}])`;
  if (type.kind !== 'object') return type.kind;

  const optional = new Set(type.optional);
  const written = Object.entries(type.attributes).map(([name, held]) => attribute(name, typeName(held), optional.has(name)));

  return written.length > 0 ? `object({ ${written.join(', ')} })` : 'object({})';
}
