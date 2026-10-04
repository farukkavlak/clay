import { ExactNumber, isRecord, isUnknown, own, Type, typeAt, types } from '@clay/contracts';

/**
 * A value with its type. `data` is plain: a string, an `ExactNumber`, a boolean or null; an array for a list, a set or a tuple; a record for a map or an
 * object. UNKNOWN stands wherever only the apply makes a value, at any depth. A set's array holds each member once, in one order.
 * The type is the one the data has, so it is `dynamic` only for a value not known yet or null, whose type nothing names.
 */
export interface Value {
  readonly type: Type;
  readonly data: unknown;
}

export function valueOf(type: Type, data: unknown): Value {
  return { type, data };
}

/** The type plain data has when nothing names one: a list of values is a tuple, and a record an object. */
export function inferred(data: unknown): Type {
  if (typeof data === 'string') return types.string;
  if (data instanceof ExactNumber) return types.number;
  if (typeof data === 'boolean') return types.bool;
  if (Array.isArray(data)) return types.tuple(data.map((item) => inferred(item)));
  if (isRecord(data)) return types.object(Object.fromEntries(Object.entries(data).map(([name, item]) => [name, inferred(item)])));

  return types.dynamic;
}

/** What one step into the value finds, with its type: an element, a tuple's item or an object's attribute. A step it has nothing at finds nothing. */
export function child(value: Value, step: string | number): Value {
  const data = Array.isArray(value.data) ? value.data[step as number] : own(value.data as Record<string, unknown>, String(step));
  const type = typeAt(value.type, step);

  return valueOf(type.kind === 'dynamic' ? inferred(data) : type, data);
}

const ARTICLES: Record<Type['kind'], string> = {
  string: 'a string',
  number: 'a number',
  bool: 'a boolean',
  dynamic: 'any value',
  list: 'a list',
  set: 'a set',
  map: 'a map',
  object: 'an object',
  tuple: 'a tuple',
};

/** A type's kind as a message says it: `a list`, `an object`. */
export function article(kind: Type['kind']): string {
  return ARTICLES[kind];
}

/** What a value is, as a message says it; one not known yet by the kind it will be, where that is known. */
export function described(value: Value): string {
  if (value.data === null) return 'null';
  if (!isUnknown(value.data)) return article(value.type.kind);

  return value.type.kind === 'dynamic' ? 'a value known only after apply' : `${article(value.type.kind)} known only after apply`;
}

/** Values as a provider, a plan and a state hold them: the data alone, typed again by the schema where it is read. */
export function plainOf(values: Record<string, Value>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).map(([name, value]) => [name, value.data]));
}
