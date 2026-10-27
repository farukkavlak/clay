import { isDeepStrictEqual } from 'node:util';

import { AttributePath, containsUnknown, EVERY_ITEM, EXACT, ExactNumber, holdsFirst, isMarker, isUnknown, sensitiveUnder, SOMEWHERE, Type, types, UNKNOWN } from '@clay/contracts';
import { CallNode, ConfigError } from '@clay/parser';

import { charactersOf } from './characters';
import { sensitiveAs } from '../values/conformValues';
import { formatted, FormatError } from './format';
import { convertedLater, elementLater, isSequence, itemTypes, joinedLater, laterOf, unifiedLater, unjoined, Unjoinable } from '../values/unify';
import {
  allSensitive,
  article,
  child,
  described,
  hasText,
  isAllSensitive,
  mayBeSensitive,
  nullSource,
  objectOf,
  sensitiveAmong,
  sensitiveOf,
  sensitiveSomewhere,
  unordered,
  Value,
  valueOf,
  withSensitive,
} from '../values/Value';
import { everyItemMarks, fewest, isSensitive, itemsOf, mayBeAllSensitive, maybeMarks, sharedMarks, wholeAs, wholeOf, wholeWhere } from '../values/sensitive';

/** Refuses at the argument `at`, the first where it is left out. */
type Refuse = (message: string, at?: number) => never;

/** `takes` arguments, or with `more`, at least that many. Each may be wholly or partly unknown. `fewer` says what to write instead of too few. */
interface ClayFunction {
  readonly takes: number;
  readonly more?: true;
  readonly fewer?: string;
  readonly call: (args: Value[], refuse: Refuse) => Value;
}

type OfOne = (value: Value, refuse: Refuse) => Value;

function one(call: OfOne): ClayFunction {
  return { takes: 1, call: ([value], refuse) => call(value, refuse) };
}

function sizeOf(data: unknown): number {
  if (typeof data === 'string') return charactersOf(data).length;

  return Array.isArray(data) ? data.length : Object.keys(data as Record<string, unknown>).length;
}

const COUNTED = new Set(['string', 'list', 'tuple', 'set', 'map', 'object']);

/** A list or map with an unknown item has a known size; a set does not, since the unknown may duplicate a member. */
function counted(value: Value, refuse: Refuse): Value {
  const takes = value.data !== null && (value.type.kind === 'dynamic' || COUNTED.has(value.type.kind));
  if (!takes) return refuse(`length takes a string, a list, a tuple, a set, a map or an object, not ${described(value)}${nullSource(value)}`);
  if (isUnknown(value.data) || unordered(value)) return valueOf(types.number, UNKNOWN);

  return valueOf(types.number, ExactNumber.parse(String(sizeOf(value.data))));
}

/** Sensitive where the whole argument is: how many items a list holds says nothing of a sensitive one among them. */
function length(value: Value, refuse: Refuse): Value {
  return wholeAs(value, counted(value, refuse));
}

function elementOf(name: string, value: Value, refuse: Refuse): Type {
  try {
    return joinedLater(itemTypes(laterOf(value)));
  } catch (error) {
    if (error instanceof Unjoinable) return refuse(`${name} ${unjoined(error, mayBeSensitive(value))}`);
    throw error;
  }
}

/** A set with an unknown member has no order, so converting it to a list gives UNKNOWN. */
function converter(kind: 'list' | 'set'): OfOne {
  const name = `to${kind}`;

  return (value, refuse) => {
    if (value.type.kind === 'dynamic') return sensitiveAs(value, valueOf(types[kind](types.dynamic), value.data));
    if (!isSequence(value.type.kind)) return refuse(`${name} takes a list, a tuple or a set, not ${described(value)}${nullSource(value)}`);

    return convertedLater(name, value, types[kind](elementOf(name, value, refuse)), [name]);
  };
}

/** A number or a boolean is read as its text, as `${}` reads it. */
function textOf(takes: string, value: Value, refuse: Refuse, at = 0): string | typeof UNKNOWN {
  if (value.data === null || !(hasText(value.type) || value.type.kind === 'dynamic')) return refuse(`${takes}, not ${described(value)}${nullSource(value)}`, at);

  return isUnknown(value.data) ? UNKNOWN : String(value.data);
}

/** Unicode's full mapping, so `ß` is `SS` in upper case, whatever the machine's language. */
function cased(name: string, change: (text: string) => string): ClayFunction {
  return one((value, refuse) => {
    const text = textOf(`${name} takes a string`, value, refuse);

    return withSensitive(valueOf(types.string, text === UNKNOWN ? UNKNOWN : change(text)), wholeOf(value));
  });
}

/** Checked by type, so `validate` finds a list of the wrong items before they are known. */
function checkJoined(list: Value, refuse: Refuse, at: number): void {
  if (list.type.kind === 'dynamic' && list.data !== null) return;
  if (list.data === null || !isSequence(list.type.kind)) refuse(`join takes lists of strings after the separator, not ${described(list)}${nullSource(list)}`, at);

  const wrong = itemTypes(list.type).find((type) => !(hasText(type) || type.kind === 'dynamic'));
  if (wrong) refuse(`join takes lists of strings, and this one holds ${article(wrong.kind)}`, at);
  // Which item is null is not told, since a sensitive list's items are a part of it.
  if (Array.isArray(list.data) && list.data.includes(null)) refuse('join takes lists of strings, and this one holds null', at);
}

/** Unknown where any item is, and sensitive as a whole where any part is: a string has no parts to mark. */
function join([separator, ...lists]: Value[], refuse: Refuse): Value {
  const between = textOf('join takes a string as the separator', separator, refuse);
  for (const [index, list] of lists.entries()) checkJoined(list, refuse, index + 1);

  const sensitive = wholeOf(separator, ...lists);
  if (between === UNKNOWN || lists.some((list) => containsUnknown(list.data))) return withSensitive(valueOf(types.string, UNKNOWN), sensitive);

  const items = lists.flatMap((list) => list.data as unknown[]);
  return withSensitive(valueOf(types.string, items.map(String).join(between)), sensitive);
}

/** A string is a boolean where it is "true" or "false", as a boolean attribute takes it. */
const TRUTHY = new Set<Type['kind']>(['bool', 'string', 'dynamic']);

/** Checked by type, so `validate` finds a list of the wrong items before they are known. */
function checkTruths(name: string, list: Value, refuse: Refuse): void {
  if (list.type.kind === 'dynamic' && list.data !== null) return;
  if (list.data === null || !isSequence(list.type.kind)) refuse(`${name} takes a list of booleans, not ${described(list)}${nullSource(list)}`);

  const wrong = itemTypes(list.type).find((type) => !TRUTHY.has(type.kind));
  if (wrong) refuse(`${name} takes a list of booleans, and this one holds ${article(wrong.kind)}`);
}

/** The text of a string is not told, since it may be sensitive. */
function truthOf(name: string, item: unknown, refuse: Refuse): boolean | typeof UNKNOWN {
  if (isUnknown(item)) return UNKNOWN;
  if (typeof item === 'boolean') return item;
  if (item === null) return refuse(`${name} takes a list of booleans, and this one holds null`);
  if (item !== 'true' && item !== 'false') return refuse(`${name} takes a list of booleans, and this one holds a string that is not "true" or "false"`);

  return item === 'true';
}

/**
 * A known item of `decides` gives `decides`, whatever the unknown items are; otherwise an unknown item leaves it unknown.
 * Sensitive as a whole where any part is, since a mark is known before the items are.
 */
function truths(name: string, decides: boolean): ClayFunction {
  return one((list, refuse) => {
    checkTruths(name, list, refuse);
    if (isUnknown(list.data)) return withSensitive(valueOf(types.bool, UNKNOWN), wholeOf(list));

    const read = new Set((list.data as unknown[]).map((item) => truthOf(name, item, refuse)));
    const result = read.has(decides) ? decides : read.has(UNKNOWN) ? UNKNOWN : !decides;
    return withSensitive(valueOf(types.bool, result), wholeOf(list));
  });
}

const KEYED = new Set<Type['kind']>(['map', 'object', 'dynamic']);

/** What a map or an object holds at `key`, not known where the whole is not. */
function entryOf(value: Value, key: string): Value {
  return isUnknown(value.data) ? { ...child(value, key), data: UNKNOWN } : child(value, key);
}

function keysOf(value: Value): string[] {
  return Object.keys(value.type.kind === 'object' ? value.type.attributes : (value.data as Record<string, unknown>));
}

/** Each value a map or an object holds; one not known yet stands for all of them. */
function entriesOf(value: Value): Value[] {
  return value.type.kind === 'object' ? keysOf(value).map((key) => entryOf(value, key)) : itemsOf(value);
}

/** Marks below `key` say every value it may be holds the key, since a value not known yet is marked only where every value it may be is. */
function marksKey(value: Value, key: string): boolean {
  return sensitiveOf(value).some((path) => holdsFirst(path) && String(path[0]) === key);
}

/** Where the key or the map is not known yet, it gives an entry or the default, so only the marks all of them have. */
function laterLookup([map, , fallback]: Value[], key: string | typeof UNKNOWN, type: Type): Value {
  if (key !== UNKNOWN && marksKey(map, key)) return withSensitive(valueOf(type, UNKNOWN), sensitiveOf(entryOf(map, key)));

  const entries = key === UNKNOWN ? entriesOf(map) : [entryOf(map, key)];
  return withSensitive(valueOf(type, UNKNOWN), sharedMarks([...entries, fallback]));
}

/** A map's value and the default join into one type, as the two results of a conditional do. */
function lookupType(map: Value, fallback: Value, refuse: Refuse): Type {
  try {
    return joinedLater([elementLater(map), laterOf(fallback)]);
  } catch (error) {
    if (!(error instanceof Unjoinable)) throw error;
    return refuse(`lookup ${unjoined(error, mayBeSensitive(map) || mayBeSensitive(fallback))}`, 2);
  }
}

function fromMap(args: Value[], key: string | typeof UNKNOWN, refuse: Refuse): Value {
  const [map, , fallback] = args;
  const type = lookupType(map, fallback, refuse);
  if (key === UNKNOWN || isUnknown(map.data)) return laterLookup(args, key, unifiedLater([fallback], [], [elementLater(map)]));

  const found = Object.hasOwn(map.data as Record<string, unknown>, key) ? child(map, key) : fallback;
  return convertedLater('lookup', found, type, []);
}

/** An object's attributes are known by its type, so its value or the default is given as it is. */
function fromObject(args: Value[], key: string | typeof UNKNOWN): Value {
  const [object, , fallback] = args;
  if (key === UNKNOWN || object.type.kind !== 'object') return laterLookup(args, key, types.dynamic);

  return Object.hasOwn(object.type.attributes, key) ? entryOf(object, key) : fallback;
}

/** Sensitive as a whole where the key or every key is, since whether it gives the default tells whether the key is there. */
function lookup(args: Value[], refuse: Refuse): Value {
  const [map, key] = args;
  if (map.data === null || !KEYED.has(map.type.kind)) return refuse(`lookup takes a map or an object, not ${described(map)}${nullSource(map)}`);

  const name = textOf('lookup takes a string as the key', key, refuse, 1);
  const found = map.type.kind === 'map' ? fromMap(args, name, refuse) : fromObject(args, name);

  return wholeWhere(found, isSensitive(key) || isAllSensitive(map), mayBeSensitive(key) || mayBeAllSensitive(map));
}

/** Arguments of one type merge into that type; anything else into an object. */
function sharedType(given: Value[]): Type | undefined {
  const [first] = given;
  if (first === undefined) return undefined;

  return given.every((arg) => isDeepStrictEqual(arg.type, first.type)) ? first.type : undefined;
}

const keysLater = (arg: Value) => arg.type.kind === 'dynamic' || (arg.type.kind === 'map' && isUnknown(arg.data));

/** The keys an argument gives for certain: all of a known one's, and those one not known yet marks, since a value not known yet is marked only where every value it may be is. */
function keysGiven(arg: Value): string[] {
  if (!keysLater(arg)) return keysOf(arg);

  return sensitiveOf(arg).flatMap((path) => (holdsFirst(path) ? [String(path[0])] : []));
}

/** The keys a mark of an argument not known yet names, so it may give them, and all of a known one's. */
function keysNamed(arg: Value): string[] {
  if (!keysLater(arg)) return keysOf(arg);

  return sensitiveOf(arg).flatMap(([first]) => (first === undefined || isMarker(first) ? [] : [String(first)]));
}

/**
 * A key comes from the last argument that gives it for certain, or from one not known yet after it, so it has the marks all of those share.
 * Where none gives it for certain, it may not be there, so it has only those any argument not known yet may give it.
 * Where none comes after it, the key is exact: what any other key may hold does not reach it.
 */
function keyMarks(given: Value[], key: string): AttributePath[] {
  const last = [...given].reverse().findIndex((arg) => keysGiven(arg).includes(key));
  const at = (marks: AttributePath[]) => marks.map((path) => [key, ...path]);
  if (last === -1) return at(maybeMarks(given.filter((arg) => keysLater(arg)).map((arg) => entryOf(arg, key))));

  const from = given.slice(given.length - 1 - last).filter((arg, index) => index === 0 || keysLater(arg));
  return at([...sharedMarks(from.map((arg) => entryOf(arg, key))), ...(from.length === 1 ? [[EXACT]] : [])]);
}

/** What an argument not known yet holds at a key no mark of it names. */
function otherEntry(arg: Value): Value {
  return withSensitive(valueOf(types.dynamic, UNKNOWN), sensitiveUnder(sensitiveOf(arg), EVERY_ITEM));
}

/** Which keys it holds waits for the apply. Each has the marks every value has, and those an argument whose keys are not known may give; a key given for certain has its own. */
function laterMerged(given: Value[], type: Type): Value {
  const keys = new Set(given.flatMap((arg) => keysNamed(arg)));

  const every = everyItemMarks(
    given.flatMap((arg) => entriesOf(arg)),
    given.filter((arg) => keysLater(arg)).map((arg) => otherEntry(arg))
  );

  return withSensitive(valueOf(type, UNKNOWN), fewest([...every, ...[...keys].flatMap((key) => keyMarks(given, key))]));
}

/** A map not known yet leaves the keys unknown, so an object made with it is not known at all. */
function merged(given: Value[]): Value {
  const shared = sharedType(given);
  if (given.some((arg) => keysLater(arg))) return laterMerged(given, shared ?? types.dynamic);

  const entries = new Map(given.flatMap((arg) => keysOf(arg).map((key): [string, Value] => [key, entryOf(arg, key)])));
  if (!shared) return objectOf([...entries]);

  const values = Object.fromEntries(entries);
  return withSensitive(valueOf(shared, Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.data]))), sensitiveAmong(values));
}

const mayHold = (arg: Value, key: string) => arg.type.kind !== 'object' || Object.hasOwn(arg.type.attributes, key);

/** An argument sensitive somewhere leaves the merge so where every later one gives only known keys it cannot hold. */
function somewhereKept(given: Value[]): boolean {
  return given.some((arg, index) => sensitiveSomewhere(arg) && given.slice(index + 1).every((later) => !keysLater(later) && keysOf(later).every((key) => !mayHold(arg, key))));
}

/** Later keys win, and a null is left out. Sensitive as a whole where one is, since the keys it holds are a part of it. */
function merge(args: Value[], refuse: Refuse): Value {
  for (const [index, arg] of args.entries()) if (!KEYED.has(arg.type.kind)) refuse(`merge takes maps or objects, not ${article(arg.type.kind)}`, index);

  const given = args.filter((arg) => arg.data !== null);
  const result = merged(given);
  return wholeWhere(
    somewhereKept(given) ? withSensitive(result, fewest([...sensitiveOf(result), [SOMEWHERE]])) : result,
    given.some((arg) => isAllSensitive(arg)),
    given.some((arg) => mayBeAllSensitive(arg))
  );
}

/** Sensitive as a whole where any part of any argument is, as `join` is. */
function format([template, ...values]: Value[], refuse: Refuse): Value {
  const text = textOf('format takes a string first', template, refuse);
  const sensitive = wholeOf(template, ...values);
  if (text === UNKNOWN) return withSensitive(valueOf(types.string, UNKNOWN), sensitive);

  try {
    return withSensitive(valueOf(types.string, formatted(text, values, isSensitive(template))), sensitive);
  } catch (error) {
    if (error instanceof FormatError) return refuse(error.message, error.at);
    throw error;
  }
}

/** A mark is known before the value is, so it is unknown only while no mark says so and a part is not known yet. */
function issensitive(value: Value): Value {
  if (isSensitive(value)) return valueOf(types.bool, true);

  return valueOf(types.bool, containsUnknown(value.data) ? UNKNOWN : false);
}

const FUNCTIONS = new Map<string, ClayFunction>([
  ['length', one(length)],
  ['sensitive', one(allSensitive)],
  ['nonsensitive', one((value) => withSensitive(value, []))],
  ['issensitive', one(issensitive)],
  ['tolist', one(converter('list'))],
  ['toset', one(converter('set'))],
  ['upper', cased('upper', (text) => text.toUpperCase())],
  ['lower', cased('lower', (text) => text.toLowerCase())],
  ['join', { takes: 2, more: true, call: join }],
  ['alltrue', truths('alltrue', false)],
  ['anytrue', truths('anytrue', true)],
  ['lookup', { takes: 3, fewer: 'without a default, read the key with map["key"]', call: lookup }],
  ['merge', { takes: 1, more: true, call: merge }],
  ['format', { takes: 1, more: true, call: format }],
]);

function counts({ takes, more }: ClayFunction): string {
  return `${more ? 'at least ' : ''}${takes} argument${takes === 1 ? '' : 's'}`;
}

/** Refuses an unknown function or a wrong argument count at the call's position. */
export function functionCalled(call: CallNode): (args: Value[]) => Value {
  const found = FUNCTIONS.get(call.name);
  if (!found) throw new ConfigError(`There is no function "${call.name}"`, call.position);

  const given = call.args.length;
  if (found.more ? given < found.takes : given !== found.takes) {
    const instead = given < found.takes && found.fewer ? `; ${found.fewer}` : '';
    throw new ConfigError(`${call.name} takes ${counts(found)}, not ${given}${instead}`, call.position);
  }

  return (args) =>
    found.call(args, (message, at = 0) => {
      throw new ConfigError(message, call.args[at].position);
    });
}
