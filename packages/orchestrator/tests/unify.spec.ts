import { Type, types } from '@clay/contracts';
import { describe, expect, it } from 'vitest';

import { unified, Unjoinable } from '../src/unify';

const { string, number, bool, dynamic } = types;

const reasonOf = (found: Type[]): string => {
  try {
    unified(found);
  } catch (error) {
    if (error instanceof Unjoinable) return error.message;

    throw error;
  }

  throw new Error('Expected the types to be refused');
};

describe('unified', () => {
  it.each<[string, Type[], Type]>([
    ['nothing as no type', [], dynamic],
    ['types nothing names as no type', [dynamic, dynamic], dynamic],
    ['one type as itself', [number, number], number],
    ['a type beside one nothing names as that type', [dynamic, bool], bool],
    ['a string with a number and a boolean as a string', [number, string, bool], string],
    ['tuples of one length position by position', [types.tuple([number, string]), types.tuple([number, bool])], types.tuple([number, string])],
    ['tuples of other lengths as a list', [types.tuple([number]), types.tuple([number, string])], types.list(string)],
    ['an empty tuple and another as a list of what the other holds', [types.tuple([]), types.tuple([number])], types.list(number)],
    ['a tuple and a list as a list', [types.tuple([number]), types.list(number)], types.list(number)],
    ['a list and a set as a set', [types.list(string), types.set(number)], types.set(string)],
    ['objects with the same names name by name', [types.object({ a: number }), types.object({ a: string })], types.object({ a: string })],
    ['an object and a map as a map', [types.map(number), types.object({ b: string })], types.map(string)],
    [
      'an attribute optional in one object as optional',
      [types.object({ a: number, b: string }, ['b']), types.object({ a: number, b: string })],
      types.object({ a: number, b: string }, ['b']),
    ],
    ['types inside types', [types.list(types.tuple([number])), types.list(types.tuple([string]))], types.list(types.tuple([string]))],
  ])('joins %s', (_, found, type) => {
    expect(unified(found)).toEqual(type);
  });

  it.each<[string, Type[], string]>([
    ['a number and a boolean', [number, bool], 'cannot join a number and a boolean into one type'],
    ['a primitive and a collection', [string, types.list(string)], 'cannot join a string and a list into one type'],
    ['a sequence and a mapping', [types.tuple([]), types.object({})], 'cannot join a tuple and an object into one type'],
    [
      'objects where the second has a name more',
      [types.object({ a: number }), types.object({ a: number, b: number })],
      'cannot join an object with "b" and one without it into one type',
    ],
    [
      'objects where the second has a name less',
      [types.object({ a: number, b: number }), types.object({ a: number })],
      'cannot join an object with "b" and one without it into one type',
    ],
    ['an attribute of objects, by its name', [types.object({ a: bool }), types.object({ a: number })], 'cannot join a number and a boolean into one type, at .a in each item'],
    ['a position of tuples, by its index', [types.tuple([bool]), types.tuple([number])], 'cannot join a number and a boolean into one type, at [0] in each item'],
  ])('refuses %s', (_, found, reason) => {
    expect(reasonOf(found)).toBe(reason);
  });
});
