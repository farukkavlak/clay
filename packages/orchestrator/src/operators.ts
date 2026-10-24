import { isDeepStrictEqual } from 'node:util';

import { AttributePath, containsUnknown, ExactNumber, isUnknown, NumberError, SENSITIVE, Type, types, UNKNOWN } from '@clay/contracts';
import { ConfigError, Position, spellSteps, Step } from '@clay/parser';

import { itemTypes } from './unify';
import {
  article,
  described,
  inferred,
  isAllSensitive,
  isSensitive,
  mayBeAllSensitive,
  mayBeSensitive,
  nullSource,
  Value,
  valueOf,
  wholeOf,
  wholeWhere,
  withSensitive,
} from './Value';

/** A list and a tuple hold items alike, and so do a map and an object. A set has no order, so it equals only a set. */
const COMPARED_AS: Record<Type['kind'], string> = {
  string: 'string',
  number: 'number',
  bool: 'bool',
  dynamic: 'dynamic',
  list: 'sequence',
  tuple: 'sequence',
  set: 'set',
  map: 'mapping',
  object: 'mapping',
};

type Pair = [one: Type, other: Type, at: Step[]];

/** Tuples pair by position and objects by name; anything else pairs every item type of one with every item type of the other. */
function pairsIn(one: Type, other: Type, at: Step[]): Pair[] {
  if (one.kind === 'tuple' && other.kind === 'tuple')
    return one.elements.slice(0, other.elements.length).map((element, index): Pair => [element, other.elements[index], [...at, { key: index }]]);
  if (one.kind === 'object' && other.kind === 'object')
    return Object.keys(one.attributes)
      .filter((name) => Object.hasOwn(other.attributes, name))
      .map((name): Pair => [one.attributes[name], other.attributes[name], [...at, { name }]]);

  return itemTypes(one).flatMap((item) => itemTypes(other).map((otherItem): Pair => [item, otherItem, at]));
}

function differs(one: Type, other: Type): boolean {
  return one.kind !== 'dynamic' && other.kind !== 'dynamic' && COMPARED_AS[one.kind] !== COMPARED_AS[other.kind];
}

/** The first pair of types inside the two where no value of one can equal a value of the other. */
function mismatchWithin(one: Type, other: Type, at: Step[]): Pair | undefined {
  for (const [item, otherItem, within] of pairsIn(one, other, at)) {
    if (differs(item, otherItem)) return [item, otherItem, within];

    const found = mismatchWithin(item, otherItem, within);
    if (found) return found;
  }

  return undefined;
}

/** Checked by type, so `validate` finds it before any value is known. A sensitive value's keys and positions are parts of it, so its items are not named. */
function checkComparable(operator: string, left: Value, right: Value, position: Position): void {
  const top = differs(left.type, right.type);
  const inside = top ? undefined : mismatchWithin(left.type, right.type, []);
  if (!top && !inside) return;

  const compared = `${operator} compares ${article(left.type.kind)} with ${article(right.type.kind)}`;
  if (!inside) throw new ConfigError(`${compared}, which are never equal`, position);
  if (mayBeSensitive(left) || mayBeSensitive(right)) throw new ConfigError(`${compared} whose items differ in type; one is sensitive, so no more is shown`, position);

  const [one, other, at] = inside;
  const where = at.length > 0 ? ` at ${spellSteps(at)}` : '';
  throw new ConfigError(`${compared} whose items differ in type: one holds ${article(one.kind)} where the other holds ${article(other.kind)}${where}`, position);
}

/** Null equals only null. A part not known yet leaves the answer to the apply. */
function sameData(one: unknown, other: unknown): boolean | typeof UNKNOWN {
  if (isUnknown(one) || isUnknown(other)) return UNKNOWN;
  if (one === null || other === null) return one === other;
  if (containsUnknown(one) || containsUnknown(other)) return UNKNOWN;

  return isDeepStrictEqual(one, other);
}

/**
 * `==` or `!=`. A `null` of no type compares with anything; a typed one is compared by its type. Any sensitive part makes the answer sensitive, except against null,
 * which tells only whether the value is there.
 */
export function equality(operator: '==' | '!=', left: Value, right: Value, position: Position): Value {
  checkComparable(operator, left, right, position);

  const againstNull = left.data === null || right.data === null;

  const same = sameData(left.data, right.data);
  const result = valueOf(types.bool, same === UNKNOWN ? UNKNOWN : same === (operator === '=='));
  if (!againstNull) return withSensitive(result, wholeOf(left, right));

  return wholeWhere(result, isAllSensitive(left) || isAllSensitive(right), mayBeAllSensitive(left) || mayBeAllSensitive(right));
}

/** Null and any other type are refused. */
export function checkBoolean(who: string, value: Value, position: Position): void {
  if (value.data !== null && (value.type.kind === 'bool' || value.type.kind === 'dynamic')) return;

  throw new ConfigError(`${who} takes a boolean, not ${described(value)}${nullSource(value)}`, position);
}

export function negated(value: Value): Value {
  return withSensitive(valueOf(types.bool, isUnknown(value.data) ? UNKNOWN : !value.data), value.sensitive ?? []);
}

export type Arithmetic = '+' | '-' | '*' | '/' | '%';

export type Ordering = '<' | '>' | '<=' | '>=';

function notANumber(who: string, value: Value, position: Position): ConfigError {
  return new ConfigError(`${who} takes a number, not ${described(value)}${nullSource(value)}`, position);
}

/** Null and any type but a number or a string are refused by type, so `validate` finds them. */
function checkNumber(who: string, value: Value, position: Position): void {
  if (value.data === null || !(value.type.kind === 'number' || value.type.kind === 'string' || value.type.kind === 'dynamic')) throw notANumber(who, value, position);
}

export type NumberValue = Value & { data: ExactNumber | typeof UNKNOWN };

function numberOf(data: ExactNumber | typeof UNKNOWN, sensitive: readonly AttributePath[]): NumberValue {
  const value = withSensitive(valueOf(types.number, data), sensitive);
  return { ...value, data: value.data as ExactNumber | typeof UNKNOWN };
}

/** A string that spells a number is read as one, as where a schema wants a number. */
export function asNumber(who: string, value: Value, position: Position): NumberValue {
  checkNumber(who, value, position);
  if (value.data === UNKNOWN || value.data instanceof ExactNumber) return numberOf(value.data, value.sensitive ?? []);
  // A value of no type is told by what it holds.
  if (typeof value.data !== 'string') throw notANumber(who, { ...value, type: inferred(value.data) }, position);

  try {
    return numberOf(ExactNumber.parse(value.data), value.sensitive ?? []);
  } catch (error) {
    if (error instanceof NumberError) throw new ConfigError(`${who} takes a number, and ${isSensitive(value) ? `${SENSITIVE} ${error.problem}` : error.message}`, position);
    throw error;
  }
}

const ARITHMETIC: Record<Arithmetic, (left: ExactNumber, right: ExactNumber) => ExactNumber> = {
  '+': (left, right) => left.plus(right),
  '-': (left, right) => left.minus(right),
  '*': (left, right) => left.times(right),
  '/': (left, right) => left.dividedBy(right),
  '%': (left, right) => left.remainder(right),
};

const DIVIDING: ReadonlySet<Arithmetic> = new Set(['/', '%']);

const ORDERING: Record<Ordering, (order: number) => boolean> = {
  '<': (order) => order < 0,
  '>': (order) => order > 0,
  '<=': (order) => order <= 0,
  '>=': (order) => order >= 0,
};

export function isOrdering(operator: Arithmetic | Ordering): operator is Ordering {
  return Object.hasOwn(ORDERING, operator);
}

/** Both sides are numbers. The result never names a number, since either side may be sensitive. */
function computed(operator: string, left: NumberValue, right: NumberValue, position: Position, compute: (left: ExactNumber, right: ExactNumber) => unknown): unknown {
  if (left.data === UNKNOWN || right.data === UNKNOWN) return UNKNOWN;

  try {
    return compute(left.data, right.data);
  } catch (error) {
    if (error instanceof NumberError) throw new ConfigError(`What ${operator} gives ${error.problem}`, position);
    throw error;
  }
}

export function arithmetic(operator: Arithmetic, left: NumberValue, right: NumberValue, position: Position): Value {
  if (DIVIDING.has(operator) && right.data !== UNKNOWN && right.data.isZero()) {
    const problem = isSensitive(right) ? 'cannot divide by this sensitive value; why is not shown' : 'divides by zero, which has no result';
    throw new ConfigError(`${operator} ${problem}`, position);
  }

  const data = computed(operator, left, right, position, ARITHMETIC[operator]);

  return withSensitive(valueOf(types.number, data), wholeOf(left, right));
}

export function ordering(operator: Ordering, left: NumberValue, right: NumberValue, position: Position): Value {
  const data = computed(operator, left, right, position, (one, other) => ORDERING[operator](one.compare(other)));

  return withSensitive(valueOf(types.bool, data), wholeOf(left, right));
}

export function negative(value: NumberValue): Value {
  return withSensitive(valueOf(types.number, value.data === UNKNOWN ? UNKNOWN : value.data.negated()), value.sensitive ?? []);
}
