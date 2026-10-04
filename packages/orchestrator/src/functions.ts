import { ExactNumber, isUnknown, types, UNKNOWN } from '@clay/contracts';
import { CallNode, ConfigError } from '@clay/parser';

import { described, unordered, Value, valueOf } from './Value';

/** Given its argument, which may be not known yet in whole or in part, and `refuse`, which says the argument is one it does not take. */
type ClayFunction = (argument: Value, refuse: (message: string) => never) => Value;

/** What a reader counts as one character, so an accented letter or an emoji made of several code points is one. */
const characters = new Intl.Segmenter('en', { granularity: 'grapheme' });

function sizeOf(data: unknown): number {
  if (typeof data === 'string') return [...characters.segment(data)].length;

  return Array.isArray(data) ? data.length : Object.keys(data as Record<string, unknown>).length;
}

const COUNTED = new Set(['string', 'list', 'tuple', 'set', 'map', 'object']);

/** A list or a map has its size while an item in it is not known; a set does not, since the member to come may be one it already holds. */
function length(value: Value, refuse: (message: string) => never): Value {
  const takes = value.data !== null && (value.type.kind === 'dynamic' || COUNTED.has(value.type.kind));
  if (!takes) return refuse(`length takes a string, a list, a tuple, a set, a map or an object, not ${described(value)}`);
  if (isUnknown(value.data) || unordered(value)) return valueOf(types.number, UNKNOWN);

  return valueOf(types.number, ExactNumber.parse(String(sizeOf(value.data))));
}

const FUNCTIONS = new Map<string, ClayFunction>([['length', length]]);

/** The function a call names, ready for its argument. A name no function has, or another number of arguments than one, is refused where the call is written. */
export function functionCalled(call: CallNode): (argument: Value) => Value {
  const found = FUNCTIONS.get(call.name);
  if (!found) throw new ConfigError(`There is no function "${call.name}"`, call.position);
  if (call.args.length !== 1) throw new ConfigError(`${call.name} takes 1 argument, not ${call.args.length}`, call.position);

  return (argument) =>
    found(argument, (message) => {
      throw new ConfigError(message, call.args[0].position);
    });
}
