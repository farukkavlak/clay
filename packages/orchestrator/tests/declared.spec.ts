import { ExactNumber, Type, types, UNKNOWN } from '@clay/contracts';
import { describe, expect, it } from 'vitest';

import { SchemaMismatch } from '../src/conformValues';
import { declaredAs } from '../src/declared';
import { inferred, Value, valueOf } from '../src/Value';

/** Data as the configuration writes it: a list a tuple, a map an object. */
const written = (data: unknown): Value => valueOf(inferred(data), data);

const n = (text: string) => ExactNumber.parse(text);

const mismatchOf = (value: Value, type: Type): SchemaMismatch => {
  try {
    declaredAs('v', value, type);
  } catch (error) {
    if (error instanceof SchemaMismatch) return error;

    throw error;
  }

  throw new Error('Expected the variable to refuse the value');
};

describe('a value held to the type its variable names', () => {
  it.each([
    ['a tuple as a set, each member once and in order', written(['b', 'a', 'a']), types.set(types.string), ['a', 'b']],
    ['a number as a string', written(n('1')), types.string, '1'],
    ['a string that spells a number as a number', written('5'), types.number, n('5')],
    ['each item of a mixed tuple as a string', written([n('1'), true, 'x']), types.list(types.string), ['1', 'true', 'x']],
    ['an object as an object of the attribute types named', written({ a: n('1') }), types.object({ a: types.string }), { a: '1' }],
    ['null, as a null of the type', written(null), types.number, null],
  ])('takes %s', (_, value, type, data) => {
    expect(declaredAs('v', value, type)).toEqual({ type, data });
  });

  it.each([
    ['any', written([n('1'), 'x']), types.dynamic, written([n('1'), 'x'])],
    ['list(any), its items joined into one type', written([n('1'), 'x']), types.list(types.dynamic), valueOf(types.list(types.string), ['1', 'x'])],
    ['map(any) over an object', written({ a: n('1'), b: 'x' }), types.map(types.dynamic), valueOf(types.map(types.string), { a: '1', b: 'x' })],
    [
      'any as an attribute, which keeps the type found there',
      written({ a: [true], b: 'x' }),
      types.object({ a: types.dynamic, b: types.string }),
      valueOf(types.object({ a: types.tuple([types.bool]), b: types.string }), { a: [true], b: 'x' }),
    ],
    ['any in a tuple, position by position', written([true, '2']), types.tuple([types.dynamic, types.number]), valueOf(types.tuple([types.bool, types.number]), [true, n('2')])],
    ['list(any) with no item', written([]), types.list(types.dynamic), valueOf(types.list(types.dynamic), [])],
  ])('reads %s from the value', (_, value, type, expected) => {
    expect(declaredAs('v', value, type)).toEqual(expected);
  });

  it('gives a value not known yet the type named', () => {
    expect(declaredAs('v', valueOf(types.dynamic, UNKNOWN), types.list(types.dynamic))).toEqual(valueOf(types.list(types.dynamic), UNKNOWN));
    expect(declaredAs('v', valueOf(types.string, UNKNOWN), types.number)).toEqual(valueOf(types.number, UNKNOWN));
  });

  it.each([
    ['a string that spells no number', written('x'), types.number, 'v: "x" is not a number'],
    ['a list where a number goes', written(['a']), types.number, 'v is a tuple, where variable "v" takes a number'],
    [
      'a value not known yet whose type can never be a number',
      valueOf(types.list(types.string), UNKNOWN),
      types.number,
      'v is a list known only after apply, where variable "v" takes a number',
    ],
    ['an attribute the object type does not name', written({ a: 'x', extra: 'y' }), types.object({ a: types.string }), 'variable "v" has no attribute "extra" in v'],
    ['an object without an attribute its type names', written({}), types.object({ a: types.string }), 'variable "v" requires "a" in v'],
    ['a number and a boolean where list(any) joins them', written([n('1'), true]), types.list(types.dynamic), 'variable "v" cannot join a number and a boolean into one type'],
  ])('refuses %s', (_, value, type, message) => {
    expect(mismatchOf(value, type).message).toContain(message);
  });

  it('converts each item on its own where no any asks to join them', () => {
    expect(declaredAs('v', written([n('1'), true]), types.list(types.string))).toEqual(valueOf(types.list(types.string), ['1', 'true']));
  });
});
