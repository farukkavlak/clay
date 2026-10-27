import { EVERY_ITEM, ExactNumber, isMaybe, MAYBE, SOMEWHERE, types, UNKNOWN } from '@clay/contracts';
import { CallNode, ConfigError } from '@clay/parser';
import { describe, expect, it } from 'vitest';

import { functionCalled } from '../../src/expressions/functions';
import { allSensitive, inferred, isAllSensitive, Value, valueOf, withSensitive } from '../../src/values/Value';

const at = (column: number) => ({ file: 'main.clay', line: 1, column });

/** The written arguments do not matter, since the function gets values; the first is at column 8 and each after it 10 on. */
const callOf = (name: string, count: number): CallNode => ({
  type: 'Call',
  name,
  args: Array.from({ length: count }, (_, index) => ({ type: 'Null', position: at(8 + index * 10) })),
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

const truth = (data: boolean | typeof UNKNOWN) => valueOf(types.bool, data);

describe('alltrue and anytrue', () => {
  it.each([
    ['a tuple of true', written([true, true]), true, true],
    ['a tuple with one false', written([true, false]), false, true],
    ['a tuple of false', written([false, false]), false, false],
    ['an empty tuple', written([]), true, false],
    ['a list', valueOf(types.list(types.bool), [false, true]), false, true],
    ['a set', valueOf(types.set(types.bool), [true]), true, true],
    ['"true" and "false" as a boolean attribute takes them', written(['true', 'false']), false, true],
  ])('read %s', (_, list, all, any) => {
    expect(called('alltrue', list)).toEqual(truth(all));
    expect(called('anytrue', list)).toEqual(truth(any));
  });

  it.each([
    ['after it', written([true, false, UNKNOWN])],
    ['before it', written([true, UNKNOWN, false])],
    ['in a set', valueOf(types.set(types.bool), [UNKNOWN, false])],
  ])('give false for alltrue with a false item and one not known yet %s', (_, list) => {
    expect(called('alltrue', list)).toEqual(truth(false));
  });

  it.each([
    ['after it', written([false, true, UNKNOWN])],
    ['before it', written([false, UNKNOWN, true])],
  ])('give true for anytrue with a true item and one not known yet %s', (_, list) => {
    expect(called('anytrue', list)).toEqual(truth(true));
  });

  it.each([
    ['an item not known yet beside the rest', written([true, UNKNOWN]), written([false, UNKNOWN])],
    ['a list not known yet', valueOf(types.list(types.bool), UNKNOWN), valueOf(types.list(types.bool), UNKNOWN)],
    ['a value not known yet whose type nothing names', valueOf(types.dynamic, UNKNOWN), valueOf(types.dynamic, UNKNOWN)],
  ])('do not know with %s', (_, forAll, forAny) => {
    expect(called('alltrue', forAll)).toEqual(truth(UNKNOWN));
    expect(called('anytrue', forAny)).toEqual(truth(UNKNOWN));
  });

  it('are sensitive as a whole with a sensitive item, though another item decides', () => {
    const list = withSensitive(written([false, true]), [[1]]);

    expect(called('alltrue', list)).toEqual(allSensitive(truth(false)));
    expect(called('anytrue', list)).toEqual(allSensitive(truth(true)));
  });

  it('may be sensitive as a whole with an item that may be', () => {
    const list = withSensitive(written([true]), [[0, MAYBE]]);

    expect(called('alltrue', list)).toEqual(withSensitive(truth(true), [[MAYBE]]));
  });

  it.each([
    ['a string', [written('true')], 'alltrue takes a list of booleans, not a string'],
    ['a map', [valueOf(types.map(types.bool), { a: true })], 'alltrue takes a list of booleans, not a map'],
    ['null', [valueOf(types.dynamic, null)], 'alltrue takes a list of booleans, not null'],
    ['a list that is null', [{ ...valueOf(types.list(types.bool), null), nullFrom: 'var.l' }], 'alltrue takes a list of booleans, not null, and var.l, which it reads, is null'],
    ['a list of numbers', [written([ExactNumber.parse('1')])], 'alltrue takes a list of booleans, and this one holds a number'],
    ['a list of lists not known yet', [valueOf(types.list(types.list(types.bool)), UNKNOWN)], 'alltrue takes a list of booleans, and this one holds a list'],
    ['a null item', [written([true, null])], 'alltrue takes a list of booleans, and this one holds null'],
    ['a string that is not a boolean', [written([false, 'yes'])], 'alltrue takes a list of booleans, and this one holds a string that is not "true" or "false"'],
  ])('refuse %s where it is written', (_, values, message) => {
    const error = errorOf('alltrue', ...values);

    expect(error.message).toBe(message);
    expect(error.position).toEqual(at(8));
  });

  it('refuse a sensitive string that is not a boolean without telling it', () => {
    expect(errorOf('alltrue', withSensitive(written(['secret']), [[0]])).message).toBe(
      'alltrue takes a list of booleans, and this one holds a string that is not "true" or "false"'
    );
  });

  it('refuse a string that is not a boolean in anytrue, though another item decides', () => {
    expect(errorOf('anytrue', written([true, 'yes'])).message).toBe('anytrue takes a list of booleans, and this one holds a string that is not "true" or "false"');
  });
});

const sizes = valueOf(types.map(types.string), { dev: 'small', prod: 'large' });

describe('lookup', () => {
  it.each([
    ['the value at a key a map holds', sizes, 'prod', written('none'), text('large')],
    ['the default for a key a map does not hold', sizes, 'test', written('none'), text('none')],
    ['the default as the type the map and it join into', sizes, 'test', number('3'), text('3')],
    ['a number as the type it joins into with a string default', valueOf(types.map(types.number), { a: ExactNumber.parse('1') }), 'a', written('x'), text('1')],
    ['the attribute of an object, as its own type', written({ a: ExactNumber.parse('1'), b: 'x' }), 'a', written('none'), number('1')],
    ['the default for a name an object does not have, as its own type', written({ a: 'x' }), 'b', written(true), written(true)],
    ['a key given as a number, by its text', valueOf(types.map(types.string), { '1': 'one' }), number('1'), written('none'), text('one')],
    ['the default for a key a map inherits from nowhere', sizes, 'constructor', written('none'), text('none')],
    ['the default for a name an object inherits from nowhere', written({ a: 'x' }), 'toString', written('none'), text('none')],
  ])('gives %s', (_, map, key, fallback, result) => {
    expect(called('lookup', map, typeof key === 'string' ? written(key) : key, fallback)).toEqual(result);
  });

  it.each([
    ['a key not known yet in a map, as the type it joins into', sizes, valueOf(types.string, UNKNOWN), written('x'), text(UNKNOWN)],
    [
      'a key not known yet in a map of numbers with a string default, as a string',
      valueOf(types.map(types.number), {}),
      valueOf(types.string, UNKNOWN),
      written('x'),
      text(UNKNOWN),
    ],
    ['a map not known yet', valueOf(types.map(types.string), UNKNOWN), written('a'), written('x'), text(UNKNOWN)],
    ['a key not known yet in an object, as any type', written({ a: 'x' }), valueOf(types.string, UNKNOWN), written('x'), valueOf(types.dynamic, UNKNOWN)],
    ['an object not known yet, as its attribute', valueOf(types.object({ a: types.number }), UNKNOWN), written('a'), written('x'), valueOf(types.number, UNKNOWN)],
    ['a value not known yet whose type nothing names', valueOf(types.dynamic, UNKNOWN), written('a'), written('x'), valueOf(types.dynamic, UNKNOWN)],
    [
      'a key a map not known yet may not hold, though it marks another and every value',
      withSensitive(valueOf(types.map(types.string), UNKNOWN), [['a'], [EVERY_ITEM]]),
      written('b'),
      written('x'),
      withSensitive(text(UNKNOWN), [[MAYBE]]),
    ],
    ['a key not known yet with a sensitive default it may not give', sizes, valueOf(types.string, UNKNOWN), allSensitive(written('x')), withSensitive(text(UNKNOWN), [[MAYBE]])],
    ['a key not known yet in a map sensitive at one key', withSensitive(sizes, [['prod']]), valueOf(types.string, UNKNOWN), written('x'), withSensitive(text(UNKNOWN), [[MAYBE]])],
  ])('does not know %s', (_, map, key, fallback, result) => {
    expect(called('lookup', map, key, fallback)).toEqual(result);
  });

  it.each([
    ['a sensitive key that is there', sizes, allSensitive(written('prod')), written('none'), allSensitive(text('large'))],
    ['a sensitive key that is not', sizes, allSensitive(written('test')), written('none'), allSensitive(text('none'))],
    ['a map sensitive as a whole', allSensitive(sizes), written('test'), written('none'), allSensitive(text('none'))],
    ['a value sensitive at the key it reads', withSensitive(sizes, [['prod']]), written('prod'), written('none'), allSensitive(text('large'))],
    ['a sensitive default it gives', sizes, written('test'), allSensitive(written('none')), allSensitive(text('none'))],
    ['a key a map not known yet marks', withSensitive(valueOf(types.map(types.string), UNKNOWN), [['a']]), written('a'), written('x'), allSensitive(text(UNKNOWN))],
    ['a sensitive key not known yet', sizes, allSensitive(valueOf(types.string, UNKNOWN)), written('x'), allSensitive(text(UNKNOWN))],
    [
      'a key not known yet where every value and the default are sensitive',
      withSensitive(sizes, [[EVERY_ITEM]]),
      valueOf(types.string, UNKNOWN),
      allSensitive(written('x')),
      allSensitive(text(UNKNOWN)),
    ],
    ['a key not known yet in a map sensitive as a whole', allSensitive(sizes), valueOf(types.string, UNKNOWN), written('x'), allSensitive(text(UNKNOWN))],
  ])('is sensitive with %s', (_, map, key, fallback, result) => {
    expect(called('lookup', map, key, fallback)).toEqual(result);
  });

  it.each([
    ['a value sensitive at another key', withSensitive(sizes, [['dev']]), 'prod', written('none'), text('large')],
    ['a sensitive default it does not give', sizes, 'prod', allSensitive(written('none')), text('large')],
  ])('is not sensitive with %s', (_, map, key, fallback, result) => {
    expect(called('lookup', map, written(key), fallback)).toEqual(result);
  });

  it.each([
    ['a list to read', [written(['a']), written('a'), written('x')], 'lookup takes a map or an object, not a tuple', 8],
    [
      'null to read',
      [{ ...valueOf(types.map(types.string), null), nullFrom: 'var.m' }, written('a'), written('x')],
      'lookup takes a map or an object, not null, and var.m, which it reads, is null',
      8,
    ],
    ['a key that is a list', [sizes, written(['a']), written('x')], 'lookup takes a string as the key, not a tuple', 18],
    ['a default no value of the map joins with', [sizes, written('a'), written(['x'])], 'lookup cannot join a string and a tuple into one type', 28],
    [
      'such a default for a map not known yet',
      [valueOf(types.map(types.string), UNKNOWN), written('a'), written(['x'])],
      'lookup cannot join a string and a tuple into one type',
      28,
    ],
    ['such a default for a key not known yet', [sizes, valueOf(types.string, UNKNOWN), written(['x'])], 'lookup cannot join a string and a tuple into one type', 28],
    [
      'such a default for a sensitive map, without its names',
      [allSensitive(valueOf(types.map(types.object({ password: types.string })), {})), written('a'), written({ password: ['x'] })],
      'lookup cannot join what it holds into one type; a part of it is sensitive, so no more is shown',
      28,
    ],
  ])('refuses %s where it is written', (_, values, message, column) => {
    const error = errorOf('lookup', ...values);

    expect(error.message).toBe(message);
    expect(error.position).toEqual(at(column));
  });

  it('refuses two arguments at the call, and says how to read a key with no default', () => {
    expect(() => functionCalled(callOf('lookup', 2))).toThrow(new ConfigError('lookup takes 3 arguments, not 2; without a default, read the key with map["key"]', at(1)));
  });

  it('refuses four arguments at the call without saying it', () => {
    expect(() => functionCalled(callOf('lookup', 4))).toThrow(new ConfigError('lookup takes 3 arguments, not 4', at(1)));
  });
});

const map = (data: Record<string, unknown>) => valueOf(types.map(types.string), data);

describe('merge', () => {
  it.each([
    ['maps of one type into that map, the later key winning', [map({ a: 'x', b: 'y' }), map({ b: 'z' })], map({ a: 'x', b: 'z' })],
    ['one map as it is', [map({ a: 'x' })], map({ a: 'x' })],
    ['objects into an object of every attribute', [written({ a: 'x' }), written({ b: true })], written({ a: 'x', b: true })],
    ['a later attribute of another type over an earlier one', [written({ a: 'x' }), written({ a: true })], written({ a: true })],
    ['maps of other types into an object', [map({ a: 'x' }), valueOf(types.map(types.bool), { b: true })], written({ a: 'x', b: true })],
    ['a map and an object into an object', [map({ a: 'x' }), written({ b: 'y' })], written({ a: 'x', b: 'y' })],
    ['a null left out', [map({ a: 'x' }), valueOf(types.map(types.string), null), valueOf(types.dynamic, null)], map({ a: 'x' })],
    ['only null into an empty object', [valueOf(types.dynamic, null)], written({})],
  ])('gives %s', (_, values, result) => {
    expect(called('merge', ...values)).toEqual(result);
  });

  it.each([
    ['a map not known yet, among maps of its type', [map({ a: 'x' }), valueOf(types.map(types.string), UNKNOWN)], valueOf(types.map(types.string), UNKNOWN)],
    ['a map not known yet, beside an object', [written({ a: 'x' }), valueOf(types.map(types.string), UNKNOWN)], valueOf(types.dynamic, UNKNOWN)],
    ['a value not known yet whose type nothing names', [map({ a: 'x' }), valueOf(types.dynamic, UNKNOWN)], valueOf(types.dynamic, UNKNOWN)],
  ])('does not know the result with %s', (_, values, result) => {
    expect(called('merge', ...values)).toEqual(result);
  });

  it('knows the attributes of an object not known yet, and the values it does not cover', () => {
    const later = valueOf(types.object({ b: types.string }), UNKNOWN);

    expect(called('merge', written({ a: 'x', b: 'y' }), later)).toEqual(valueOf(types.object({ a: types.string, b: types.string }), { a: 'x', b: UNKNOWN }));
  });

  it.each([
    ['a part sensitive at a key that stays', [withSensitive(map({ a: 'x', b: 'y' }), [['a']]), map({ b: 'z' })], withSensitive(map({ a: 'x', b: 'z' }), [['a']])],
    ['a part sensitive at a key a later one covers', [withSensitive(map({ a: 'x' }), [['a']]), map({ a: 'z' })], map({ a: 'z' })],
    ['a later object sensitive at an attribute', [written({ a: 'x' }), withSensitive(written({ b: 'y' }), [['b']])], withSensitive(written({ a: 'x', b: 'y' }), [['b']])],
  ])('keeps sensitive only what stays: %s', (_, values, result) => {
    expect(called('merge', ...values)).toEqual(result);
  });

  it('is sensitive as a whole where an argument is, since the keys it covers show its own', () => {
    expect(called('merge', map({ a: 'x' }), allSensitive(map({ b: 'y' })))).toEqual(allSensitive(map({ a: 'x', b: 'y' })));
  });

  it.each([
    ['a list', [map({ a: 'x' }), written(['a'])], 'merge takes maps or objects, not a tuple', 18],
    ['a string that is null', [valueOf(types.string, null)], 'merge takes maps or objects, not a string', 8],
  ])('refuses %s where it is written', (_, values, message, column) => {
    const error = errorOf('merge', ...values);

    expect(error.message).toBe(message);
    expect(error.position).toEqual(at(column));
  });

  const later = (paths: (string | number)[][]) => withSensitive(valueOf(types.map(types.string), UNKNOWN), paths);

  it.each([
    ['a key an argument not known yet marks, where every later value is sensitive', [later([['a']]), later([[EVERY_ITEM]])], [['a']]],
    ['no key an argument marks, where a later one may give it plain', [later([['a']]), later([])], []],
    ['a key a known argument gives after the last one not known yet', [later([]), withSensitive(map({ a: 'x' }), [['a']])], [['a']]],
    [
      'a key a known argument gives before one not known yet, where that one marks every value',
      [withSensitive(map({ a: 'x' }), [['a']]), later([[EVERY_ITEM]])],
      [[EVERY_ITEM], ['a']],
    ],
    ['somewhere of an argument sensitive somewhere, where no later one gives a key', [later([[SOMEWHERE]]), map({})], [[SOMEWHERE]]],
    ['no somewhere of a map sensitive somewhere, where a later one gives a key the map may hold', [later([[SOMEWHERE]]), map({ c: 'x' })], []],
  ])('keeps, with an argument not known yet, %s', (_, values, marks) => {
    expect((called('merge', ...values).marks?.paths() ?? []).filter((path) => !isMaybe(path))).toEqual(marks);
  });
});

const formatOf = (template: string, ...values: Value[]) => called('format', written(template), ...values);

describe('format', () => {
  it.each([
    ['a string', '%s', [written('web')], 'web'],
    ['a number as its text', '%s', [number('1.50')], '1.5'],
    ['a boolean as its text', '%s', [written(true)], 'true'],
    ['an argument picked by its place, and the one after it next', '%[2]s-%s-%[1]s', [written('a'), written('b'), written('c')], 'b-c-a'],
    ['a percent sign', '100%%', [], '100%'],
    ['nothing but text', 'plain', [], 'plain'],
    ['a string quoted', '%q', [written('a "b"\n')], String.raw`"a \"b\"\n"`],
    ['a string cut to its first characters', '%.2s', [written('héllo')], 'hé'],
    ['a string cut to nothing', '%.0s', [written('abc')], ''],
    ['a string cut before it is quoted', '%.2q', [written('abc')], '"ab"'],
    ['a string padded to a width', '%5s|%-5s|%05s', [written('ab'), written('ab'), written('ab')], '   ab|ab   |000ab'],
    ['a width counted in characters', '%3s', [written('\u{1F468}‍\u{1F469}‍\u{1F467}')], '  \u{1F468}‍\u{1F469}‍\u{1F467}'],
    ['a number as its text with %v', '%v', [number('1e21')], '1000000000000000000000'],
    ['a string as it is with %v', '%v', [written('a')], 'a'],
    ['a boolean with %v', '%v', [written(false)], 'false'],
    ['null with %v', '%v', [valueOf(types.string, null)], 'null'],
    ['null padded with %v', '%6v|', [valueOf(types.string, null)], '  null|'],
    ['a string padded to the widest width', '%1000s', [written('a')], `${' '.repeat(999)}a`],
    ['an object as JSON with its keys in order', '%v', [written({ b: ExactNumber.parse('2'), a: ['x', true, null] })], '{"a":["x",true,null],"b":2}'],
    ['a string as JSON with %#v', '%#v|%#v', [written('a'), number('5')], '"a"|5'],
    ['a value padded with %v', '%-4v|', [written(true)], 'true|'],
    ['true with %t', '%t', [written(true)], 'true'],
    ['a string that spells a boolean with %t', '%t', [written('false')], 'false'],
    ['an integer', '%d', [number('-42')], '-42'],
    ['a string that spells an integer', '%d', [written('12')], '12'],
    ['an integer past 2^53 exactly', '%d', [number('123456789012345678901')], '123456789012345678901'],
    ['zeros after the sign', '%05d|%+05d|%-05d|', [number('-42'), number('42'), number('42')], '-0042|+0042|42   |'],
    ['a sign or a space', '%+d|% d|% d', [number('7'), number('7'), number('-7')], '+7| 7|-7'],
    ['the fewest digits a precision asks', '%.3d|%6.3d|%05.3d', [number('7'), number('7'), number('42')], '007|   007|  042'],
    ['nothing for zero at precision 0', '[%.0d]', [number('0')], '[]'],
    [
      'no sign for zero at precision 0, only the width',
      '[%+.0d][% .0d][%+3.0d][%03.0d][%#.0x][%#5.0b]',
      [number('0'), number('0'), number('0'), number('0'), number('0'), number('0')],
      '[][][   ][   ][][     ]',
    ],
    ['an integer in base 2, 8 and 16', '%b %o %x %X', [number('5'), number('8'), number('255'), number('255')], '101 10 ff FF'],
    ['the prefix of each base', '%#b %#o %#x %#X', [number('5'), number('8'), number('255'), number('255')], '0b101 010 0xff 0XFF'],
    ['zeros after the sign and the prefix', '%#08x|%+#08x|%-#8x|', [number('-255'), number('255'), number('255')], '-0x000ff|+0x000ff|0xff    |'],
    ['an integer past 2^53 in base 16', '%x', [number('123456789012345678901')], '6b14e9f812f366c35'],
    ['six places with %f', '%f|%f', [number('1'), number('-1234.5678')], '1.000000|-1234.567800'],
    ['a precision with %f', '%.2f|%.0f', [number('3.14159'), number('7.9')], '3.14|8'],
    ['a half rounded to the even digit with %f', '%.1f %.1f %.0f %.0f %.2f', [number('0.25'), number('0.35'), number('2.5'), number('3.5'), number('2.675')], '0.2 0.4 2 4 2.68'],
    ['a negative number rounded to zero, keeping its sign', '%.1f', [number('-0.04')], '-0.0'],
    ['every digit of a number past 2^53 with %f', '%.1f', [number('123456789012345678901234567890.15')], '123456789012345678901234567890.2'],
    ['zeros, a sign and a width with %f', '%08.2f|%+.1f|% .1f|%-7.1f|', [number('-3.14159'), number('1'), number('1'), number('1')], '-0003.14|+1.0| 1.0|1.0    |'],
    ['a string that spells a number with %f', '%.1f', [written('2.25')], '2.2'],
    ['an exponent of two digits with %e', '%e|%.2E|%.0e', [number('1234.5678'), number('0.000012'), number('7')], '1.234568e+03|1.20E-05|7e+00'],
    ['a half rounded up to the next power with %e', '%.0e|%.1e', [number('9.5'), number('0.0995')], '1e+01|1.0e-01'],
    ['an exponent past 99 with %e', '%.1e', [number('-1.25e-150')], '-1.2e-150'],
    ['every digit and no trailing zeros with %g', '%g|%g|%g', [number('1234.5678'), number('1.50'), number('0.0001')], '1234.5678|1.5|0.0001'],
    ['an exponent below -4 or from 6 up with %g', '%g|%g|%G', [number('0.00001234'), number('1234567'), number('1e23')], '1.234e-05|1.234567e+06|1E+23'],
    ['significant digits with %g', '%.3g|%.3g|%.0g|%.3g', [number('1234'), number('3.14159'), number('0.25'), number('1.20001')], '1.23e+03|3.14|0.2|1.2'],
    ['zero with %g', '%g|%.3g', [number('0'), number('0')], '0|0'],
  ])('writes %s', (_, template, values, result) => {
    expect(formatOf(template, ...values)).toEqual(text(result));
  });

  it.each([
    ['an argument not known yet', valueOf(types.number, UNKNOWN)],
    ['a list with an item not known yet', written(['a', UNKNOWN])],
    ['a value whose type nothing names', valueOf(types.dynamic, UNKNOWN)],
  ])('does not know the string with %s', (_, value) => {
    expect(formatOf('x-%v', value)).toEqual(text(UNKNOWN));
  });

  it('does not know the string, and reads nothing of it, while the string is not known', () => {
    expect(called('format', valueOf(types.string, UNKNOWN), written(['a']))).toEqual(text(UNKNOWN));
  });

  it.each([
    ['a sensitive argument', [written('%s-%s'), written('a'), allSensitive(written('b'))]],
    ['a sensitive part of an argument', [written('%s-%v'), written('a'), withSensitive(written({ k: 'b' }), [['k']])]],
    ['a sensitive string', [allSensitive(written('%s-b')), written('a')]],
  ])('is sensitive as a whole with %s', (_, values) => {
    expect(isAllSensitive(called('format', ...values))).toBe(true);
  });

  it('is sensitive while not known with a sensitive argument', () => {
    expect(formatOf('%s', allSensitive(valueOf(types.string, UNKNOWN)))).toEqual(allSensitive(text(UNKNOWN)));
  });

  it.each([
    ['a string that is a list', [written(['%s'])], 'format takes a string first, not a tuple', 8],
    ['a verb it does not take', [written('%z')], 'format cannot read "%z": there is no verb %z; format takes %s, %q, %v, %t, %d, %b, %o, %x, %X, %f, %e, %E, %g, %G and %%', 8],
    ['a string that ends before its verb', [written('50%')], 'format cannot read "%": the string ends before a verb', 8],
    ['a flag the verb does not take', [written('%+s'), written('a')], 'format cannot read "%+s": %s takes no "+" flag', 8],
    ['a precision the verb does not take', [written('%.2v'), written('a')], 'format cannot read "%.2v": %v takes no precision', 8],
    ['a width past the cap', [written('%1001s'), written('a')], 'format cannot read "%1001s": a width or a precision is at most 1000', 8],
    ['argument 0', [written('%[0]s'), written('a')], 'format cannot read "%[0]s": an argument is picked as [1], [2] and so on', 8],
    ['an argument with a leading zero', [written('%[01]s'), written('a')], 'format cannot read "%[01]s": an argument is picked as [1], [2] and so on', 8],
    ['a verb with no argument', [written('%s %s'), written('a')], 'format cannot read "%s": it needs argument 2 after the string, and there is 1', 8],
    ['an argument past the last', [written('%[3]s'), written('a'), written('b')], 'format cannot read "%[3]s": it needs argument 3 after the string, and there are 2', 8],
    ['an argument after the last verb', [written('%s'), written('a'), written('b')], "format's string has no verb for this argument", 28],
    ['an argument a picked one skips', [written('%[2]s'), written('a'), written('b')], "format's string has no verb for this argument", 18],
    ['an argument with no verb at all', [written('x'), written('a')], "format's string has no verb for this argument", 18],
    ['null', [written('%s'), valueOf(types.string, null)], 'format cannot write null with "%s"; only %v writes null', 18],
    [
      'null a reference reads',
      [written('%d'), { ...valueOf(types.number, null), nullFrom: 'var.n' }],
      'format cannot write null with "%d"; only %v writes null, and var.n, which it reads, is null',
      18,
    ],
    ['a list as a string', [written('%s'), written(['a'])], 'format cannot write a tuple with "%s"', 18],
    ['a list not known yet as a string', [written('%s'), valueOf(types.list(types.string), UNKNOWN)], 'format cannot write a list with "%s"', 18],
    ['a list held where nothing names the type', [written('%s'), valueOf(types.dynamic, ['a'])], 'format cannot write a tuple with "%s"', 18],
    ['a boolean as an integer', [written('%d'), written(true)], 'format cannot write a boolean with "%d"', 18],
    ['a number as a boolean', [written('%t'), number('1')], 'format cannot write a number with "%t"', 18],
    ['a fraction as an integer', [written('%d'), number('1.5')], 'format cannot write 1.5 with "%d", which takes a whole number', 18],
    ['a fraction in base 16', [written('%x'), number('1.5')], 'format cannot write 1.5 with "%x", which takes a whole number', 18],
    ['a string that spells no number with %f', [written('%f'), written('abc')], 'format cannot write "abc" with "%f", which takes a number; it is not a number', 18],
    ['a boolean with %g', [written('%g'), written(true)], 'format cannot write a boolean with "%g"', 18],
    ['a prefix flag on a decimal verb', [written('%#f'), number('1')], 'format cannot read "%#f": %f takes no "#" flag', 8],
    ['a prefix flag on %d', [written('%#d'), number('1')], 'format cannot read "%#d": %d takes no "#" flag', 8],
    ['a string that spells no number', [written('%d'), written('abc')], 'format cannot write "abc" with "%d", which takes a whole number; it is not a number', 18],
    ['a string that spells no boolean', [written('%t'), written('yes')], 'format cannot write "yes" with "%t", which takes true or false', 18],
    [
      'a sensitive value, without showing it',
      [written('%d'), allSensitive(written('abc'))],
      'format cannot write (sensitive value) with "%d", which takes a whole number; it is not a number',
      18,
    ],
    ['a verb of a sensitive string, without showing it', [allSensitive(written('%z'))], 'format cannot read a verb in its string; it is sensitive, so its parts are not shown', 8],
    [
      'an argument to a sensitive string, without showing the verb',
      [allSensitive(written('%d')), written(['a'])],
      'format cannot write a tuple with a verb of its sensitive string',
      18,
    ],
    [
      'a value a sensitive string cannot write, without saying what the verb takes',
      [allSensitive(written('%d')), written('abc')],
      'format cannot write "abc" with a verb of its sensitive string',
      18,
    ],
    [
      'null to a sensitive string, without saying which verb takes it',
      [allSensitive(written('%s')), valueOf(types.string, null)],
      'format cannot write null with a verb of its sensitive string',
      18,
    ],
  ])('refuses %s where it is written', (_, values, message, column) => {
    const error = errorOf('format', ...values);

    expect(error.message).toBe(message);
    expect(error.position).toEqual(at(column));
  });

  it('refuses an argument not known yet by its type, so validate finds it', () => {
    expect(errorOf('format', written('%d %s'), number('1'), valueOf(types.map(types.string), UNKNOWN)).message).toBe('format cannot write a map with "%s"');
  });

  it('refuses no string at the call', () => {
    expect(() => functionCalled(callOf('format', 0))).toThrow(new ConfigError('format takes at least 1 argument, not 0', at(1)));
  });
});

describe('issensitive', () => {
  it.each([
    ['a value sensitive for certain', withSensitive(written({ a: 'x' }), [['a']]), true],
    ['a value with a part that may be sensitive', withSensitive(written({ a: 'x' }), [['a', MAYBE]]), UNKNOWN],
    ['a known plain value', written({ a: 'x' }), false],
  ])('answers for %s', (_, value, answer) => {
    expect(called('issensitive', value).data).toBe(answer);
  });
});
