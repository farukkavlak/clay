import { ExactNumber, types, UNKNOWN } from '@clay/contracts';
import { CallNode, ConfigError } from '@clay/parser';
import { describe, expect, it } from 'vitest';

import { functionCalled } from '../src/functions';
import { allSensitive, inferred, Value, valueOf, withSensitive } from '../src/Value';

const at = (column: number) => ({ file: 'main.clay', line: 1, column });

/** The written arguments do not matter, since the function gets values; the first is at column 8 and each after it 10 on. */
const callOf = (name: string, count: number): CallNode => ({
  type: 'Call',
  name,
  args: Array.from({ length: count }, (_, index) => ({ type: 'Null', position: at(8 + index * 10) })),
  path: [],
  position: at(1),
});

const called = (name: string, ...values: Value[]) => functionCalled(callOf(name, values.length))(values);

const length = (value: Value) => called('length', value);

/** As the configuration writes it: a list is a tuple and a map an object. */
const written = (data: unknown): Value => valueOf(inferred(data), data);

const number = (text: string) => valueOf(types.number, ExactNumber.parse(text));

const errorOf = (name: string, ...values: Value[]): ConfigError => {
  try {
    called(name, ...values);
  } catch (error) {
    if (error instanceof ConfigError) return error;

    throw error;
  }

  throw new Error(`Expected ${name} to refuse the value`);
};

describe('a call', () => {
  it.each([
    ['length', 0, 'length takes 1 argument, not 0'],
    ['length', 2, 'length takes 1 argument, not 2'],
    ['upper', 2, 'upper takes 1 argument, not 2'],
    ['join', 1, 'join takes at least 2 arguments, not 1'],
  ])('refuses %s with %i arguments at the call', (name, count, message) => {
    expect(() => functionCalled(callOf(name, count))).toThrow(new ConfigError(message, at(1)));
  });

  it('takes as many lists as join is given', () => {
    expect(called('join', written('-'), written(['a']), written(['b']), written(['c']))).toEqual(written('a-b-c'));
  });
});

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
    ['a null a reference gave', { ...valueOf(types.string, null), nullFrom: 'var.k' }, 'tolist takes a list, a tuple or a set, not null, and var.k, which it reads, is null'],
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

const text = (data: unknown) => valueOf(types.string, data);

describe('upper and lower', () => {
  it.each([
    ['upper', written('Hello'), 'HELLO'],
    ['lower', written('Hello'), 'hello'],
    ['upper', written('stra\u00DFe'), 'STRASSE'],
    ['upper', written('i'), 'I'],
    ['lower', written('\u00C7I'), '\u00E7i'],
    ['upper', number('1.5'), '1.5'],
    ['upper', written(true), 'TRUE'],
  ])('%s gives %o as text', (name, value, result) => {
    expect(called(name, value)).toEqual(text(result));
  });

  it.each([
    ['a string not known yet', valueOf(types.string, UNKNOWN), text(UNKNOWN)],
    ['a value not known yet whose type nothing names', valueOf(types.dynamic, UNKNOWN), text(UNKNOWN)],
    ['a sensitive string', allSensitive(written('a')), allSensitive(text('A'))],
    ['a sensitive string not known yet', allSensitive(valueOf(types.string, UNKNOWN)), allSensitive(text(UNKNOWN))],
  ])('gives %s', (_, value, result) => {
    expect(called('upper', value)).toEqual(result);
  });

  it.each([
    ['a list', written(['a']), 'lower takes a string, not a tuple'],
    ['null', valueOf(types.dynamic, null), 'lower takes a string, not null'],
    ['a null a reference gave', { ...valueOf(types.string, null), nullFrom: 'var.k' }, 'lower takes a string, not null, and var.k, which it reads, is null'],
    ['a map not known yet', valueOf(types.map(types.string), UNKNOWN), 'lower takes a string, not a map'],
  ])('refuses %s where the argument is written', (_, value, message) => {
    const error = errorOf('lower', value);

    expect(error.message).toBe(message);
    expect(error.position).toEqual(at(8));
  });
});

describe('join', () => {
  it.each([
    ['a tuple of strings', written(['a', 'b']), 'a, b'],
    ['a number and a boolean as their text', written([ExactNumber.parse('1.5'), true]), '1.5, true'],
    ['a list', strings('a', 'b'), 'a, b'],
    ['a set, in the order its members are held', valueOf(types.set(types.string), ['a', 'b']), 'a, b'],
    ['an empty tuple', written([]), ''],
  ])('joins %s', (_, list, result) => {
    expect(called('join', written(', '), list)).toEqual(text(result));
  });

  it.each([
    ['an item not known yet', written(['a']), written(['b', UNKNOWN])],
    ['a list not known yet', written(['a']), valueOf(types.list(types.string), UNKNOWN)],
    ['a value not known yet whose type nothing names', written(['a']), valueOf(types.dynamic, UNKNOWN)],
    ['a set with a member not known yet', written(['a']), valueOf(types.set(types.string), ['b', UNKNOWN])],
  ])('does not know the string with %s', (_, first, second) => {
    expect(called('join', written('-'), first, second)).toEqual(text(UNKNOWN));
  });

  it('does not know the string with a separator not known yet', () => {
    expect(called('join', valueOf(types.string, UNKNOWN), written(['a']))).toEqual(text(UNKNOWN));
  });

  it.each([
    ['a sensitive item', withSensitive(written(['a', 'b']), [[1]]), written('-')],
    ['a sensitive separator', written(['a', 'b']), allSensitive(written('-'))],
  ])('is sensitive as a whole with %s', (_, list, separator) => {
    expect(called('join', separator, list)).toEqual(allSensitive(text('a-b')));
  });

  it('is sensitive while not known with a sensitive item', () => {
    expect(called('join', written('-'), withSensitive(written(['a', UNKNOWN]), [[0]]))).toEqual(allSensitive(text(UNKNOWN)));
  });

  it.each([
    ['a separator that is a list', [written(['-']), written(['a'])], 'join takes a string as the separator, not a tuple', 8],
    ['a map to join', [written('-'), written(['a']), valueOf(types.map(types.string), { a: 'x' })], 'join takes lists of strings after the separator, not a map', 28],
    ['null to join', [written('-'), valueOf(types.dynamic, null)], 'join takes lists of strings after the separator, not null', 18],
    [
      'a list that is null',
      [written('-'), { ...valueOf(types.list(types.string), null), nullFrom: 'var.l' }],
      'join takes lists of strings after the separator, not null, and var.l, which it reads, is null',
      18,
    ],
    ['a list of lists', [written('-'), written([['a']])], 'join takes lists of strings, and this one holds a tuple', 18],
    ['a list of lists not known yet', [written('-'), valueOf(types.list(types.list(types.string)), UNKNOWN)], 'join takes lists of strings, and this one holds a list', 18],
    ['a null item', [written('-'), written(['a', null])], 'join takes lists of strings, and this one holds null', 18],
    ['a null item of a sensitive list, without saying which', [written('-'), allSensitive(written(['a', null]))], 'join takes lists of strings, and this one holds null', 18],
  ])('refuses %s where it is written', (_, values, message, column) => {
    const error = errorOf('join', ...values);

    expect(error.message).toBe(message);
    expect(error.position).toEqual(at(column));
  });
});
