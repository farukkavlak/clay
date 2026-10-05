import { Type, typeAt, types } from '@clay/contracts';

import { converted, SchemaMismatch } from './conformValues';
import { itemTypes, unified, Unjoinable } from './unify';
import { Value } from './Value';

function namesAny(type: Type): boolean {
  return type.kind === 'dynamic' || itemTypes(type).some((item) => namesAny(item));
}

/** The declared type with each `any` in it taken from what was found there; a collection's items share one type, as `tolist` gives them. */
function settled(declared: Type, found: Type): Type {
  if (!namesAny(declared)) return declared;
  if (declared.kind === 'dynamic') return found;

  if (declared.kind === 'object') return types.object(Object.fromEntries(Object.entries(declared.attributes).map(([name, type]) => [name, settled(type, typeAt(found, name))])));
  if (declared.kind === 'tuple') return types.tuple(declared.elements.map((type, index) => settled(type, typeAt(found, index))));
  if (declared.kind === 'list' || declared.kind === 'set' || declared.kind === 'map') return types[declared.kind](settled(declared.element, unified(itemTypes(found))));

  return declared;
}

/** A variable's value as the type the variable names, or a `SchemaMismatch` that says why it cannot be. */
export function declaredAs(name: string, value: Value, type: Type): Value {
  const variable = `variable "${name}"`;

  try {
    return converted(variable, value, settled(type, value.type), [name]);
  } catch (error) {
    if (error instanceof Unjoinable) throw new SchemaMismatch(`${variable} ${error.message}`, name);
    throw error;
  }
}
