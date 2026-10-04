import { ExactNumber, types, UNKNOWN } from '@clay/contracts';
import { CallNode, ConfigError } from '@clay/parser';
import { describe, expect, it } from 'vitest';

import { functionCalled } from '../src/functions';
import { inferred, Value, valueOf } from '../src/Value';

const at = (column: number) => ({ file: 'main.clay', line: 1, column });

/** `length(null)` as the parser reads it; what the argument is written as does not matter, since the function is handed its value. */
const call: CallNode = { type: 'Call', name: 'length', args: [{ type: 'Null', position: at(8) }], path: [], position: at(1) };

const length = (value: Value) => functionCalled(call)(value);

/** Data as the configuration writes it: a list a tuple, a map an object. */
const written = (data: unknown): Value => valueOf(inferred(data), data);

const number = (text: string) => valueOf(types.number, ExactNumber.parse(text));

const errorOf = (value: Value): ConfigError => {
  try {
    length(value);
  } catch (error) {
    if (error instanceof ConfigError) return error;

    throw error;
  }

  throw new Error('Expected length to refuse the value');
};

describe('length', () => {
  it.each([
    ['the items of a tuple', written(['a', 'b', 'a']), '3'],
    ['the items of a list', valueOf(types.list(types.string), ['a']), '1'],
    ['the items of an empty list', written([]), '0'],
    ['the members of a set', valueOf(types.set(types.string), ['a', 'b']), '2'],
    ['the keys of an object', written({ a: 'x', b: 'y' }), '2'],
    ['the keys of a map', valueOf(types.map(types.string), { a: 'x' }), '1'],
    ['the characters of a string', written('abc'), '3'],
    ['nothing in an empty string', written(''), '0'],
  ])('counts %s', (_, value, count) => {
    expect(length(value)).toEqual(number(count));
  });

  it.each([
    ['a letter with an accent', 'h\u00E9llo', '5'],
    ['a letter and the accent joined to it', 'he\u0301llo', '5'],
    ['an emoji made of several', '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}', '1'],
  ])('counts %s as one character', (_, text, count) => {
    expect(length(written(text))).toEqual(number(count));
  });

  it.each([
    ['a list', written(['z', UNKNOWN]), '2'],
    ['a map', written({ k: UNKNOWN }), '1'],
  ])('knows the size of %s while an item in it is not known', (_, value, count) => {
    expect(length(value)).toEqual(number(count));
  });

  it.each([
    ['a string not known yet', valueOf(types.string, UNKNOWN)],
    ['a value not known yet whose type nothing names', valueOf(types.dynamic, UNKNOWN)],
    ['a set with a member not known yet', valueOf(types.set(types.string), ['z', UNKNOWN])],
    ['a set with a member known in part', valueOf(types.set(types.object({ a: types.string })), [{ a: UNKNOWN }])],
  ])('does not know the size of %s', (_, value) => {
    expect(length(value)).toEqual(valueOf(types.number, UNKNOWN));
  });

  it.each([
    ['a number', number('5'), 'a number'],
    ['a boolean', written(true), 'a boolean'],
    ['null', valueOf(types.dynamic, null), 'null'],
    ['a list that is null', valueOf(types.list(types.string), null), 'null'],
    ['a number not known yet', valueOf(types.number, UNKNOWN), 'a number known only after apply'],
  ])('refuses %s where the argument is written', (_, value, described) => {
    const error = errorOf(value);

    expect(error.message).toBe(`length takes a string, a list, a tuple, a set, a map or an object, not ${described}`);
    expect(error.position).toEqual(at(8));
  });
});
