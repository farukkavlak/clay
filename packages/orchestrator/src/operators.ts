import { isDeepStrictEqual } from 'node:util';

import { containsUnknown, isUnknown, Type, types, UNKNOWN } from '@clay/contracts';
import { ConfigError, Position, spellSteps, Step } from '@clay/parser';

import { itemTypes } from './unify';
import { article, described, isAllSensitive, isSensitive, nullSource, Value, valueOf, wholeIf, withSensitive } from './Value';

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

/** Checked by type, so `validate` finds it before any value is known. A sensitive value's type is a part of it, so it is not named. */
function checkComparable(operator: string, left: Value, right: Value, position: Position): void {
  const top = differs(left.type, right.type);
  const inside = top ? undefined : mismatchWithin(left.type, right.type, []);
  if (!top && !inside) return;

  if (isSensitive(left) || isSensitive(right)) throw new ConfigError(`${operator} compares values that can never be equal; one is sensitive, so no more is shown`, position);

  const compared = `${operator} compares ${article(left.type.kind)} with ${article(right.type.kind)}`;
  if (!inside) throw new ConfigError(`${compared}, which are never equal`, position);

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

  const sensitive = againstNull ? isAllSensitive(left) || isAllSensitive(right) : isSensitive(left) || isSensitive(right);
  const same = sameData(left.data, right.data);
  const data = same === UNKNOWN ? UNKNOWN : same === (operator === '==');

  return withSensitive(valueOf(types.bool, data), wholeIf(sensitive));
}

/** Null and any other type are refused. A sensitive value's type is a part of it, so it is not named. */
export function checkBoolean(who: string, value: Value, position: Position): void {
  if (value.data !== null && (value.type.kind === 'bool' || value.type.kind === 'dynamic')) return;

  const problem = isSensitive(value) ? 'and this sensitive value is not one; why is not shown' : `not ${described(value)}${nullSource(value)}`;
  throw new ConfigError(`${who} takes a boolean, ${problem}`, position);
}

export function negated(value: Value): Value {
  return withSensitive(valueOf(types.bool, isUnknown(value.data) ? UNKNOWN : !value.data), value.sensitive ?? []);
}
