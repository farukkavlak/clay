import { types } from '@clay/contracts';
import { describe, expect, it } from 'vitest';

import { typeFits } from '../src/typeFits';

describe('typeFits', () => {
  it.each([
    ['the same primitive', types.string, types.string],
    ['anything where the plan knew no type', types.dynamic, types.set(types.number)],
    ['a list whose items the plan knew no type for', types.list(types.dynamic), types.list(types.string)],
    ['a tuple with a part the plan knew no type for', types.tuple([types.string, types.dynamic]), types.tuple([types.string, types.bool])],
    ['an object with the same attributes', types.object({ a: types.string, b: types.dynamic }), types.object({ a: types.string, b: types.number })],
  ])('takes %s', (_, planned, actual) => {
    expect(typeFits(planned, actual)).toBe(true);
  });

  it.each([
    ['another primitive', types.string, types.number],
    ['a known type where a value has none', types.string, types.dynamic],
    ['a list where the plan held a set', types.set(types.string), types.list(types.string)],
    ['a tuple where the plan held a set', types.set(types.string), types.tuple([types.string])],
    ['a list of another item type', types.list(types.string), types.list(types.number)],
    ['a tuple of another length', types.tuple([types.string]), types.tuple([types.string, types.string])],
    ['a tuple with another part', types.tuple([types.string]), types.tuple([types.number])],
    ['a list where the plan held a tuple', types.tuple([types.string]), types.list(types.string)],
    ['an object with an attribute more', types.object({ a: types.string }), types.object({ a: types.string, b: types.string })],
    ['an object with another attribute', types.object({ a: types.string }), types.object({ b: types.string })],
    ['an object with an attribute of another type', types.object({ a: types.string }), types.object({ a: types.number })],
    ['a map where the plan held an object', types.object({ a: types.string }), types.map(types.string)],
  ])('refuses %s', (_, planned, actual) => {
    expect(typeFits(planned, actual)).toBe(false);
  });
});
