import { Type } from '@clay/contracts';

export type ObjectType = Extract<Type, { kind: 'object' }>;

/** An optional attribute left out is null, so an object has one form whoever gives it. */
export function withLeftOut(type: ObjectType, given: Record<string, unknown>): Record<string, unknown> {
  const leftOut = (type.optional ?? []).filter((name) => !Object.hasOwn(given, name));

  return { ...given, ...Object.fromEntries(leftOut.map((name) => [name, null])) };
}
