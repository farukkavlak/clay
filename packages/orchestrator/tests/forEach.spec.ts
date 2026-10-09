import { ExactNumber, types, UNKNOWN } from '@clay/contracts';
import { describe, expect, it } from 'vitest';

import { eachFrom } from '../src/forEach';
import { allSensitive, inferred, Value, valueOf, withSensitive } from '../src/Value';

/** As the configuration writes it: a list is a tuple and a map an object. */
const written = (data: unknown): Value => valueOf(inferred(data), data);

const made = (value: Value) => [...eachFrom(value)].map(([key, given]) => [key, given.data]);

describe('the instances a for_each makes', () => {
  it('makes one for each key of a map, given its value', () => {
    const port = ExactNumber.parse('80');

    expect(made(written({ web: port, api: 'x' }))).toEqual([
      ['api', 'x'],
      ['web', port],
    ]);
  });

  it('gives each instance its value with the type its place names', () => {
    expect(eachFrom(valueOf(types.map(types.set(types.string)), { a: ['x'] })).get('a')).toEqual(valueOf(types.set(types.string), ['x']));
  });

  it('makes one for each string of a list, given the string as its value', () => {
    expect(made(written(['b', 'a']))).toEqual([
      ['a', 'a'],
      ['b', 'b'],
    ]);
  });

  // An object lists a key like "1" first whatever the written order, so only sorting gives a stable order.
  it('orders the keys by their characters, whatever order they are written in', () => {
    const one = ExactNumber.parse('1');

    expect([...eachFrom(written({ b: one, 10: one, a: one, 9: one })).keys()]).toEqual(['10', '9', 'a', 'b']);
    expect([...eachFrom(written(['b', '10', 'a', '9'])).keys()]).toEqual(['10', '9', 'a', 'b']);
  });

  it('makes none from an empty map or list', () => {
    expect(eachFrom(written({})).size).toBe(0);
    expect(eachFrom(written([])).size).toBe(0);
  });

  // A map's keys are known before its values, so unknown values leave the keys known.
  it('makes one for each key of a map whose values are not known yet, given what it has of them', () => {
    expect(made(written({ b: UNKNOWN, a: { id: UNKNOWN, name: 'x' } }))).toEqual([
      ['a', { id: UNKNOWN, name: 'x' }],
      ['b', UNKNOWN],
    ]);
  });

  it('makes one for each member of a set', () => {
    expect(made(valueOf(types.set(types.string), ['a', 'b']))).toEqual([
      ['a', 'a'],
      ['b', 'b'],
    ]);
  });

  // A set's members have no index, so the message names the member's type.
  it('refuses a set that holds what is not a string, without an index', () => {
    expect(() => eachFrom(valueOf(types.set(types.dynamic), ['a', ExactNumber.parse('1')]))).toThrow('for_each is a set of strings, but it holds a number');
  });

  it('takes an empty string as a key', () => {
    expect(made(written(['']))).toEqual([['', '']]);
  });

  it.each([
    ['a value only an apply makes', valueOf(types.dynamic, UNKNOWN), 'for_each must be known when planning: it reads a value only an apply makes'],
    ['a map only an apply makes', valueOf(types.map(types.string), UNKNOWN), 'for_each must be known when planning: it reads a value only an apply makes'],
    ['a string only an apply makes', valueOf(types.string, UNKNOWN), 'for_each is a map, or a list or a set of strings, not a string'],
    // A list's items are its keys.
    [
      'a list with an item only an apply makes',
      written(['a', UNKNOWN]),
      'for_each must be known when planning: item [1] reads a value only an apply makes, and a list names its instances by its items',
    ],
    // The unknown member may add any key.
    [
      'a set with a member only an apply makes',
      valueOf(types.set(types.string), ['a', UNKNOWN]),
      'for_each must be known when planning: a member reads a value only an apply makes, and a set names its instances by its members',
    ],
    ['a string', written('a'), 'for_each is a map, or a list or a set of strings, not a string'],
    ['a number', written(ExactNumber.parse('2')), 'for_each is a map, or a list or a set of strings, not a number'],
    ['a boolean', written(true), 'for_each is a map, or a list or a set of strings, not a boolean'],
    ['null', valueOf(types.dynamic, null), 'for_each is a map, or a list or a set of strings, not null'],
    ['null of a type it takes', valueOf(types.map(types.string), null), 'for_each is a map, or a list or a set of strings, not null'],
    ['a list with a number in it', written(['a', ExactNumber.parse('1')]), 'for_each is a list of strings, but item [1] is a number'],
    ['a list with a list in it', written([['a']]), 'for_each is a list of strings, but item [0] is a tuple'],
    ['a list with null in it', written(['a', null]), 'for_each is a list of strings, but item [1] is null'],
    ['a set with null in it', valueOf(types.set(types.string), ['a', null]), 'for_each is a set of strings, but it holds null'],
    ['a list with a string twice', written(['a', 'b', 'a']), 'for_each holds "a" twice; each instance needs a key of its own'],
  ])('refuses %s', (_, value, message) => {
    expect(() => eachFrom(value)).toThrow(message);
  });

  it.each([
    ['a map sensitive as a whole', allSensitive(written({ a: 'x' }))],
    ['a tuple with a sensitive item', withSensitive(written(['a', 'b']), [[1]])],
    ['a list with a sensitive item', withSensitive(valueOf(types.list(types.string), ['a', 'b']), [[1]])],
    ['a sensitive set', allSensitive(valueOf(types.set(types.string), ['a']))],
    ['a sensitive value only an apply makes', allSensitive(valueOf(types.dynamic, UNKNOWN))],
    ['a sensitive set with a member only an apply makes', allSensitive(valueOf(types.set(types.string), [UNKNOWN]))],
  ])('refuses %s, since a key shows in an address', (_, value) => {
    expect(() => eachFrom(value)).toThrow('for_each is sensitive: a key shows in an address, so it cannot be hidden');
  });

  it('takes a map with a sensitive value under a key that is not, and gives the instance the value still sensitive', () => {
    const each = eachFrom(withSensitive(written({ db: 'hunter2', web: 'x' }), [['db']]));

    expect(each.get('db')).toEqual(allSensitive(valueOf(types.string, 'hunter2')));
    expect(each.get('web')).toEqual(valueOf(types.string, 'x'));
  });
});
