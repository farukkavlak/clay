import { isRecord } from './isRecord';

/**
 * A set's members are unordered and unique. An object's attributes are required unless `optional` lists them, unlike a schema's `optional` flag.
 * `dynamic` means the type comes from the value itself.
 */
export type Type =
  | { readonly kind: 'string' | 'number' | 'bool' | 'dynamic' }
  | { readonly kind: 'list' | 'set' | 'map'; readonly element: Type }
  | { readonly kind: 'object'; readonly attributes: Readonly<Record<string, Type>>; readonly optional?: readonly string[] }
  | { readonly kind: 'tuple'; readonly elements: readonly Type[] };

export const types = {
  string: Object.freeze({ kind: 'string' } satisfies Type),
  number: Object.freeze({ kind: 'number' } satisfies Type),
  bool: Object.freeze({ kind: 'bool' } satisfies Type),
  dynamic: Object.freeze({ kind: 'dynamic' } satisfies Type),
  list: (element: Type): Type => ({ kind: 'list', element }),
  set: (element: Type): Type => ({ kind: 'set', element }),
  map: (element: Type): Type => ({ kind: 'map', element }),
  object: <A extends Record<string, Type>>(attributes: A, optional?: (keyof A & string)[]): Type =>
    optional ? { kind: 'object', attributes, optional } : { kind: 'object', attributes },
  tuple: (elements: Type[]): Type => ({ kind: 'tuple', elements }),
};

const PRIMITIVES = new Set<unknown>(['string', 'number', 'bool', 'dynamic']);
const COLLECTIONS = new Set<unknown>(['list', 'set', 'map']);

function isOptionalList(optional: unknown, attributes: Record<string, unknown>): boolean {
  return optional === undefined || (Array.isArray(optional) && optional.every((name) => typeof name === 'string' && Object.hasOwn(attributes, name)));
}

/** Checks the whole type, since one wrong part would check values against the wrong type. */
export function isType(value: unknown): value is Type {
  if (!isRecord(value)) return false;

  const { kind } = value;
  if (PRIMITIVES.has(kind)) return true;
  if (COLLECTIONS.has(kind)) return isType(value.element);
  if (kind === 'object')
    return isRecord(value.attributes) && Object.values(value.attributes).every((attribute) => isType(attribute)) && isOptionalList(value.optional, value.attributes);

  return kind === 'tuple' && Array.isArray(value.elements) && value.elements.every((element) => isType(element));
}

/** The type one step inside `type`; `dynamic` where it names none. */
export function typeAt(type: Type, step: string | number): Type {
  if (type.kind === 'list' || type.kind === 'set' || type.kind === 'map') return type.element;
  if (type.kind === 'tuple' && typeof step === 'number') return type.elements[step] ?? types.dynamic;
  if (type.kind === 'object' && typeof step === 'string' && Object.hasOwn(type.attributes, step)) return type.attributes[step];

  return types.dynamic;
}
