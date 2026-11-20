import { describe, expect, it } from 'vitest';

import { ExactNumber, nestingOf, Type, typeNestingOf, types } from '../src';

describe('nestingOf', () => {
  it.each([
    ['a string', 'a', 0],
    ['a number', ExactNumber.parse('1'), 0],
    ['an empty list', [], 1],
    ['a list in a map in a list', [{ a: [1] }], 3],
    ['its deepest item, not its first or last', [1, [[2]], [3]], 3],
  ])('counts %s', (_, value, levels) => {
    expect(nestingOf(value)).toBe(levels);
  });

  it('counts a value deeper than the call stack holds', () => {
    let value: unknown = 1;
    for (let level = 0; level < 20_000; level++) value = [value];

    expect(nestingOf(value)).toBe(20_000);
  });
});

describe('typeNestingOf', () => {
  it.each([
    ['a string', types.string, 0],
    ['a list of strings', types.list(types.string), 1],
    ['an empty tuple', types.tuple([]), 1],
    ['a map in an object in a set', types.set(types.object({ a: types.map(types.number) })), 3],
    ['its deepest part, not its first or last', types.tuple([types.bool, types.list(types.list(types.bool)), types.list(types.bool)]), 3],
  ])('counts %s', (_, type, levels) => {
    expect(typeNestingOf(type)).toBe(levels);
  });

  it('counts a type deeper than the call stack holds', () => {
    let type: Type = types.string;
    for (let level = 0; level < 20_000; level++) type = types.object({ a: type });

    expect(typeNestingOf(type)).toBe(20_000);
  });
});
