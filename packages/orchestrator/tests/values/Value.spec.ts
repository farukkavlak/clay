import { ExactNumber, types, UNKNOWN } from '@clay/contracts';
import { describe, expect, it } from 'vitest';

import { child, described, inferred, valueOf, withSensitive } from '../../src/values/Value';

/** The fewest milliseconds of three that taking each of `size` sensitive values out of a map takes, so a pause of the machine does not count. */
function childEach(size: number): number {
  const keys = Array.from({ length: size }, (_, index) => `k${index}`);
  const map = withSensitive(
    valueOf(types.map(types.string), Object.fromEntries(keys.map((key) => [key, key]))),
    keys.map((key) => [key])
  );
  const times = Array.from({ length: 3 }, () => {
    const started = performance.now();
    for (const key of keys) child(map, key);
    return performance.now() - started;
  });
  return Math.min(...times);
}

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

  it('keeps the mark of a value it finds', () => {
    const map = withSensitive(valueOf(types.map(types.string), { a: 'x', b: 'y' }), [['b']]);

    expect(child(map, 'a').marks).toBeUndefined();
    expect(child(map, 'b').marks?.paths()).toEqual([[]]);
  });

  it('finds each sensitive value of a map in time that grows with the map', () => {
    childEach(500);

    expect(childEach(8000) / childEach(2000)).toBeLessThan(8);
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
