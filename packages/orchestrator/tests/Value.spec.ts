import { ExactNumber, types, UNKNOWN } from '@clay/contracts';
import { describe, expect, it } from 'vitest';

import { child, described, inferred, valueOf } from '../src/Value';

describe('a value with its type', () => {
  it('has the type its shape gives it, where nothing names one: a list a tuple, a map an object', () => {
    expect(inferred({ a: ['x', ExactNumber.parse('1'), true] })).toEqual(types.object({ a: types.tuple([types.string, types.number, types.bool]) }));
  });

  it('has no type yet where it is not known, or null', () => {
    expect(inferred(UNKNOWN)).toEqual(types.dynamic);
    expect(inferred(null)).toEqual(types.dynamic);
  });

  it.each([
    ['an element of a list', valueOf(types.list(types.set(types.string)), [['a']]), 0, valueOf(types.set(types.string), ['a'])],
    ['an item of a tuple', valueOf(types.tuple([types.string, types.number]), ['a', ExactNumber.parse('1')]), 1, valueOf(types.number, ExactNumber.parse('1'))],
    ['an attribute of an object', valueOf(types.object({ a: types.bool }), { a: true }), 'a', valueOf(types.bool, true)],
    ['a value of a map', valueOf(types.map(types.string), { a: 'x' }), 'a', valueOf(types.string, 'x')],
    // A dynamic element names no type, so its data gives it one.
    ['an element of a dynamic list', valueOf(types.list(types.dynamic), [['a']]), 0, valueOf(types.tuple([types.string]), ['a'])],
    ['an element not known yet', valueOf(types.list(types.string), [UNKNOWN]), 0, valueOf(types.string, UNKNOWN)],
  ])('finds %s with the type its place names', (_, value, step, found) => {
    expect(child(value, step)).toEqual(found);
  });

  // `toString` is on every object, so only a key the map holds is found.
  it('finds nothing at a name the map does not hold', () => {
    expect(child(valueOf(types.map(types.string), {}), 'toString').data).toBeUndefined();
  });

  it.each([
    ['a tuple', valueOf(types.tuple([]), []), 'a tuple'],
    ['an object', valueOf(types.object({}), {}), 'an object'],
    ['a boolean', valueOf(types.bool, true), 'a boolean'],
    ['null of a type', valueOf(types.string, null), 'null'],
    ['a value not known yet of a type', valueOf(types.list(types.string), UNKNOWN), 'a list'],
    ['a value not known yet of no type', valueOf(types.dynamic, UNKNOWN), 'any value'],
  ])('describes %s', (_, value, words) => {
    expect(described(value)).toBe(words);
  });
});
