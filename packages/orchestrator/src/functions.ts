import { ExactNumber, isUnknown, Type, types, UNKNOWN } from '@clay/contracts';
import { CallNode, ConfigError } from '@clay/parser';

import { converted, sensitiveAs } from './conformValues';
import { isSequence, itemTypes, unified, Unjoinable } from './unify';
import { allSensitiveIf, described, isAllSensitive, unordered, Value, valueOf } from './Value';

/** The argument may be wholly or partly unknown. */
type ClayFunction = (argument: Value, refuse: (message: string) => never) => Value;

/** Grapheme clusters, so an accented letter or a multi-code-point emoji counts as one. */
const characters = new Intl.Segmenter('en', { granularity: 'grapheme' });

function sizeOf(data: unknown): number {
  if (typeof data === 'string') return [...characters.segment(data)].length;

  return Array.isArray(data) ? data.length : Object.keys(data as Record<string, unknown>).length;
}

const COUNTED = new Set(['string', 'list', 'tuple', 'set', 'map', 'object']);

/** A list or map with an unknown item has a known size; a set does not, since the unknown may duplicate a member. */
function counted(value: Value, refuse: (message: string) => never): Value {
  const takes = value.data !== null && (value.type.kind === 'dynamic' || COUNTED.has(value.type.kind));
  if (!takes) return refuse(`length takes a string, a list, a tuple, a set, a map or an object, not ${described(value)}`);
  if (isUnknown(value.data) || unordered(value)) return valueOf(types.number, UNKNOWN);

  return valueOf(types.number, ExactNumber.parse(String(sizeOf(value.data))));
}

/** Sensitive where the whole argument is: how many items a list holds says nothing of a sensitive one among them. */
function length(value: Value, refuse: (message: string) => never): Value {
  return allSensitiveIf(isAllSensitive(value), counted(value, refuse));
}

function elementOf(name: string, type: Type, refuse: (message: string) => never): Type {
  try {
    return unified(itemTypes(type));
  } catch (error) {
    if (error instanceof Unjoinable) return refuse(`${name} ${error.message}`);
    throw error;
  }
}

/** A set with an unknown member has no order, so converting it to a list gives UNKNOWN. */
function converter(kind: 'list' | 'set'): ClayFunction {
  const name = `to${kind}`;

  return (value, refuse) => {
    if (value.type.kind === 'dynamic') return sensitiveAs(value, valueOf(types[kind](types.dynamic), value.data));
    if (!isSequence(value.type.kind)) return refuse(`${name} takes a list, a tuple or a set, not ${described(value)}`);

    return converted(name, value, types[kind](elementOf(name, value.type, refuse)), [name]);
  };
}

const FUNCTIONS = new Map<string, ClayFunction>([
  ['length', length],
  ['tolist', converter('list')],
  ['toset', converter('set')],
]);

/** Refuses an unknown function or a wrong argument count at the call's position. */
export function functionCalled(call: CallNode): (argument: Value) => Value {
  const found = FUNCTIONS.get(call.name);
  if (!found) throw new ConfigError(`There is no function "${call.name}"`, call.position);
  if (call.args.length !== 1) throw new ConfigError(`${call.name} takes 1 argument, not ${call.args.length}`, call.position);

  return (argument) =>
    found(argument, (message) => {
      throw new ConfigError(message, call.args[0].position);
    });
}
