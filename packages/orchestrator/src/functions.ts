import { containsUnknown, ExactNumber, isUnknown, Type, types, UNKNOWN } from '@clay/contracts';
import { CallNode, ConfigError } from '@clay/parser';

import { converted, sensitiveAs } from './conformValues';
import { isSequence, itemTypes, unified, unjoined, Unjoinable } from './unify';
import { allSensitive, allSensitiveIf, article, described, hasText, isAllSensitive, isSensitive, nullSource, unordered, Value, valueOf, wholeIf, withSensitive } from './Value';

/** Refuses at the argument `at`, the first where it is left out. */
type Refuse = (message: string, at?: number) => never;

/** `takes` arguments, or with `more`, at least that many. Each may be wholly or partly unknown. */
interface ClayFunction {
  readonly takes: number;
  readonly more?: true;
  readonly call: (args: Value[], refuse: Refuse) => Value;
}

type OfOne = (value: Value, refuse: Refuse) => Value;

function one(call: OfOne): ClayFunction {
  return { takes: 1, call: ([value], refuse) => call(value, refuse) };
}

/** Grapheme clusters, so an accented letter or a multi-code-point emoji counts as one. */
const characters = new Intl.Segmenter('en', { granularity: 'grapheme' });

function sizeOf(data: unknown): number {
  if (typeof data === 'string') return [...characters.segment(data)].length;

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
  return allSensitiveIf(isAllSensitive(value), counted(value, refuse));
}

function elementOf(name: string, value: Value, refuse: Refuse): Type {
  try {
    return unified(itemTypes(value.type));
  } catch (error) {
    if (error instanceof Unjoinable) return refuse(`${name} ${unjoined(error, isSensitive(value))}`);
    throw error;
  }
}

/** A set with an unknown member has no order, so converting it to a list gives UNKNOWN. */
function converter(kind: 'list' | 'set'): OfOne {
  const name = `to${kind}`;

  return (value, refuse) => {
    if (value.type.kind === 'dynamic') return sensitiveAs(value, valueOf(types[kind](types.dynamic), value.data));
    if (!isSequence(value.type.kind)) return refuse(`${name} takes a list, a tuple or a set, not ${described(value)}${nullSource(value)}`);

    return converted(name, value, types[kind](elementOf(name, value, refuse)), [name]);
  };
}

/** A number or a boolean is read as its text, as `${}` reads it. */
function textOf(takes: string, value: Value, refuse: Refuse): string | typeof UNKNOWN {
  if (value.data === null || !(hasText(value.type) || value.type.kind === 'dynamic')) return refuse(`${takes}, not ${described(value)}${nullSource(value)}`);

  return isUnknown(value.data) ? UNKNOWN : String(value.data);
}

/** Unicode's full mapping, so `ß` is `SS` in upper case, whatever the machine's language. */
function cased(name: string, change: (text: string) => string): ClayFunction {
  return one((value, refuse) => {
    const text = textOf(`${name} takes a string`, value, refuse);

    return withSensitive(valueOf(types.string, text === UNKNOWN ? UNKNOWN : change(text)), wholeIf(isSensitive(value)));
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

  const sensitive = wholeIf([separator, ...lists].some((arg) => isSensitive(arg)));
  if (between === UNKNOWN || lists.some((list) => containsUnknown(list.data))) return withSensitive(valueOf(types.string, UNKNOWN), sensitive);

  const items = lists.flatMap((list) => list.data as unknown[]);
  return withSensitive(valueOf(types.string, items.map(String).join(between)), sensitive);
}

/** Unknown only when nothing says it is sensitive: a mark is known before the value is. */
function issensitive(value: Value): Value {
  if (isSensitive(value)) return valueOf(types.bool, true);

  return valueOf(types.bool, isUnknown(value.data) ? UNKNOWN : false);
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
]);

function counts({ takes, more }: ClayFunction): string {
  return `${more ? 'at least ' : ''}${takes} argument${takes === 1 ? '' : 's'}`;
}

/** Refuses an unknown function or a wrong argument count at the call's position. */
export function functionCalled(call: CallNode): (args: Value[]) => Value {
  const found = FUNCTIONS.get(call.name);
  if (!found) throw new ConfigError(`There is no function "${call.name}"`, call.position);

  const given = call.args.length;
  if (found.more ? given < found.takes : given !== found.takes) throw new ConfigError(`${call.name} takes ${counts(found)}, not ${given}`, call.position);

  return (args) =>
    found.call(args, (message, at = 0) => {
      throw new ConfigError(message, call.args[at].position);
    });
}
