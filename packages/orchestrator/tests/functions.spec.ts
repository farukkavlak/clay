import { ExactNumber, types, UNKNOWN } from '@clay/contracts';
import { CallNode, ConfigError } from '@clay/parser';
import { describe, expect, it } from 'vitest';

import { functionCalled } from '../src/functions';
import { inferred, Value, valueOf } from '../src/Value';

const at = (column: number) => ({ file: 'main.clay', line: 1, column });

/** `length(null)`; the written argument does not matter, since the function gets a value. */
const call: CallNode = { type: 'Call', name: 'length', args: [{ type: 'Null', position: at(8) }], path: [], position: at(1) };

const called = (name: string, value: Value) => functionCalled({ ...call, name })(value);

const length = (value: Value) => called('length', value);

/** As the configuration writes it: a list is a tuple and a map an object. */
const written = (data: unknown): Value => valueOf(inferred(data), data);

const number = (text: string) => valueOf(types.number, ExactNumber.parse(text));

const errorOf = (name: string, value: Value): ConfigError => {
  try {
    called(name, value);
  } catch (error) {
    if (error instanceof ConfigError) return error;

    throw error;
  }

  throw new Error(`Expected ${name} to refuse the value`);
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
    ['a number not known yet', valueOf(types.number, UNKNOWN), 'a number'],
  ])('refuses %s where the argument is written', (_, value, described) => {
    const error = errorOf('length', value);

    expect(error.message).toBe(`length takes a string, a list, a tuple, a set, a map or an object, not ${described}`);
    expect(error.position).toEqual(at(8));
  });
});

const strings = (...data: unknown[]) => valueOf(types.list(types.string), data);

describe('tolist', () => {
  it.each([
    ['a tuple of strings, in its order', written(['b', 'a', 'b']), strings('b', 'a', 'b')],
    ['a tuple of a string and a number, each as a string', written(['a', ExactNumber.parse('1')]), strings('a', '1')],
    ['a set, in the order its members are held', valueOf(types.set(types.string), ['a', 'b']), strings('a', 'b')],
    ['a list, as it is', strings('a'), strings('a')],
    ['an empty tuple, as a list of no type', written([]), valueOf(types.list(types.dynamic), [])],
    [
      'a tuple of objects, each attribute as the type they share',
      written([{ a: ExactNumber.parse('1') }, { a: 'x' }]),
      valueOf(types.list(types.object({ a: types.string })), [{ a: '1' }, { a: 'x' }]),
    ],
    ['a tuple with null, as the type the rest are', written([null, 'a']), strings(null, 'a')],
  ])('gives %s', (_, value, list) => {
    expect(called('tolist', value)).toEqual(list);
  });

  it.each([
    ['a tuple with an item not known yet, which keeps the rest', written(['a', UNKNOWN]), strings('a', UNKNOWN)],
    ['a list not known yet', valueOf(types.list(types.string), UNKNOWN), valueOf(types.list(types.string), UNKNOWN)],
    ['a tuple not known yet, as a list of what its items share', valueOf(types.tuple([types.string, types.number]), UNKNOWN), valueOf(types.list(types.string), UNKNOWN)],
    ['a value not known yet whose type nothing names', valueOf(types.dynamic, UNKNOWN), valueOf(types.list(types.dynamic), UNKNOWN)],
    ['a set with a member not known yet, which has no order yet', valueOf(types.set(types.string), ['z', UNKNOWN]), valueOf(types.list(types.string), UNKNOWN)],
    ['null', valueOf(types.dynamic, null), valueOf(types.list(types.dynamic), null)],
  ])('gives %s', (_, value, list) => {
    expect(called('tolist', value)).toEqual(list);
  });

  it.each([
    ['an object', written({ a: 'x' }), 'tolist takes a list, a tuple or a set, not an object'],
    ['a string', written('a'), 'tolist takes a list, a tuple or a set, not a string'],
    ['a map not known yet', valueOf(types.map(types.string), UNKNOWN), 'tolist takes a list, a tuple or a set, not a map'],
    ['a number and a boolean', written([ExactNumber.parse('1'), true]), 'tolist cannot join a number and a boolean into one type'],
    ['objects with other names', written([{ a: 'x' }, { b: 'x' }]), 'tolist cannot join an object with "b" and one without it into one type'],
  ])('refuses %s where the argument is written', (_, value, message) => {
    const error = errorOf('tolist', value);

    expect(error.message).toBe(message);
    expect(error.position).toEqual(at(8));
  });
});

describe('toset', () => {
  it.each([
    ['each member once, in one order', written(['b', 'a', 'b']), valueOf(types.set(types.string), ['a', 'b'])],
    ['a number and the string that spells it as one member', written([ExactNumber.parse('1'), '1']), valueOf(types.set(types.string), ['1'])],
    ['an item not known yet after the members known', written([UNKNOWN, 'a']), valueOf(types.set(types.string), ['a', UNKNOWN])],
    ['a set, as it is', valueOf(types.set(types.string), ['a']), valueOf(types.set(types.string), ['a'])],
    ['null', valueOf(types.dynamic, null), valueOf(types.set(types.dynamic), null)],
  ])('gives %s', (_, value, set) => {
    expect(called('toset', value)).toEqual(set);
  });

  it('refuses a map where the argument is written', () => {
    const error = errorOf('toset', valueOf(types.map(types.string), { a: 'x' }));

    expect(error.message).toBe('toset takes a list, a tuple or a set, not a map');
    expect(error.position).toEqual(at(8));
  });
});
