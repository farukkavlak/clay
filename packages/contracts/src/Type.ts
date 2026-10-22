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

/** The parts `value` holds as a type, or undefined where its own fields make it none. */
function partsOf(value: unknown): readonly unknown[] | undefined {
  if (!isRecord(value)) return undefined;

  const { kind } = value;
  if (PRIMITIVES.has(kind)) return [];
  if (COLLECTIONS.has(kind)) return [value.element];
  if (kind === 'object') return isRecord(value.attributes) && isOptionalList(value.optional, value.attributes) ? Object.values(value.attributes) : undefined;

  return kind === 'tuple' && Array.isArray(value.elements) ? value.elements : undefined;
}

/** Checks every part, with a stack of its own, as a provider's type may be nested deeper than the call stack holds. */
export function isType(value: unknown): value is Type {
  const pending = [value];

  while (pending.length > 0) {
    const parts = partsOf(pending.pop());
    if (parts === undefined) return false;
    for (const part of parts) pending.push(part);
  }

  return true;
}

/** The type one step inside `type`; `dynamic` where it names none. */
export function typeAt(type: Type, step: string | number): Type {
  if (type.kind === 'list' || type.kind === 'set' || type.kind === 'map') return type.element;
  if (type.kind === 'tuple' && typeof step === 'number') return type.elements[step] ?? types.dynamic;
  if (type.kind === 'object' && typeof step === 'string' && Object.hasOwn(type.attributes, step)) return type.attributes[step];

  return types.dynamic;
}
