import { ExactNumber, types, UNKNOWN } from '@clay/contracts';
import { ConfigError } from '@clay/parser';
import { describe, expect, it } from 'vitest';

import { checkBoolean, equality, negated } from '../src/operators';
import { allSensitive, inferred, Value, valueOf, withSensitive } from '../src/Value';

const position = { file: 'main.clay', line: 1, column: 5 };

/** As the configuration writes it: a list is a tuple and a map an object. */
const written = (data: unknown): Value => valueOf(inferred(data), data);

const number = (text: string) => ExactNumber.parse(text);

const bool = (data: boolean | typeof UNKNOWN) => valueOf(types.bool, data);

const nullOf = valueOf(types.dynamic, null);

function refusal(work: () => unknown): ConfigError {
  try {
    work();
  } catch (error) {
    if (error instanceof ConfigError) return error;

    throw error;
  }

  throw new Error('Expected a refusal');
}

const equal = (left: Value, right: Value) => equality('==', left, right, position);

describe('==', () => {
  it.each([
    ['equal strings', written('a'), written('a'), true],
    ['different strings', written('a'), written('b'), false],
    ['one number written two ways', written(number('1')), written(number('1.0')), true],
    ['a tuple and a list with the same items', written(['a']), valueOf(types.list(types.string), ['a']), true],
    ['an object and a map with the same keys', written({ k: 'v' }), valueOf(types.map(types.string), { k: 'v' }), true],
    ['two empty tuples', written([]), written([]), true],
    ['tuples of different lengths', written(['a']), written(['a', 'b']), false],
    ['objects with different names', written({ a: 'x' }), written({ b: 'x' }), false],
    ['sets with the same members', valueOf(types.set(types.string), ['a', 'b']), valueOf(types.set(types.string), ['a', 'b']), true],
    ['null and null', nullOf, nullOf, true],
    ['null and a value', nullOf, written('a'), false],
  ])('compares %s', (_, left, right, same) => {
    expect(equal(left, right)).toEqual(bool(same));
  });

  it('gives the opposite for !=', () => {
    expect(equality('!=', written('a'), written('a'), position)).toEqual(bool(false));
    expect(equality('!=', written('a'), written('b'), position)).toEqual(bool(true));
  });

  it.each([
    ['an unknown and a value', valueOf(types.string, UNKNOWN), written('a')],
    ['an unknown and null, since the unknown may be null', valueOf(types.string, UNKNOWN), nullOf],
    ['a list with an unknown item and a list', written(['a', UNKNOWN]), written(['a', 'b'])],
  ])('leaves %s to the apply', (_, left, right) => {
    expect(equal(left, right)).toEqual(bool(UNKNOWN));
  });

  it('knows a value with an unknown part is not null', () => {
    expect(equal(written(['a', UNKNOWN]), nullOf)).toEqual(bool(false));
  });

  it.each([
    ['a number with a string', written(number('1')), written('1'), '== compares a number with a string, which are never equal'],
    ['a string with a boolean', written('true'), written(true), '== compares a string with a boolean, which are never equal'],
    ['a tuple with an object', written([]), written({}), '== compares a tuple with an object, which are never equal'],
    ['a set with a tuple', valueOf(types.set(types.string), ['a']), written(['a']), '== compares a set with a tuple, which are never equal'],
    [
      'tuples by position',
      written(['a', number('1')]),
      written(['a', 'b']),
      '== compares a tuple with a tuple whose items differ in type: one holds a number where the other holds a string at [1]',
    ],
    [
      'objects by name',
      written({ a: { b: true } }),
      written({ a: { b: 'x' } }),
      '== compares an object with an object whose items differ in type: one holds a boolean where the other holds a string at .a.b',
    ],
    [
      'a list with a tuple by item',
      valueOf(types.list(types.number), []),
      written(['a']),
      '== compares a list with a tuple whose items differ in type: one holds a number where the other holds a string',
    ],
  ])('refuses %s', (_, left, right, message) => {
    const error = refusal(() => equal(left, right));

    expect(error.message).toBe(message);
    expect(error.position).toEqual(position);
  });

  it('refuses by type, before the value is known', () => {
    expect(refusal(() => equal(valueOf(types.number, UNKNOWN), valueOf(types.string, UNKNOWN))).message).toBe('== compares a number with a string, which are never equal');
  });

  it('takes a value of no type yet with anything', () => {
    expect(equal(valueOf(types.dynamic, UNKNOWN), written(number('1')))).toEqual(bool(UNKNOWN));
  });

  it('names no type when a side is sensitive', () => {
    expect(refusal(() => equal(allSensitive(written(number('1'))), written('a'))).message).toBe(
      '== compares values that can never be equal; one is sensitive, so no more is shown'
    );
  });

  it.each([
    ['a side sensitive as a whole', allSensitive(written('a')), written('a')],
    ['a sensitive part of a side', withSensitive(written({ a: 'x' }), [['a']]), written({ a: 'x' })],
  ])('is sensitive with %s', (_, left, right) => {
    expect(equal(left, right)).toEqual(allSensitive(bool(true)));
  });

  it('against null is sensitive only where a side is as a whole', () => {
    expect(equal(withSensitive(written({ a: 'x' }), [['a']]), nullOf)).toEqual(bool(false));
    expect(equal(allSensitive(written({ a: 'x' })), nullOf)).toEqual(allSensitive(bool(false)));
  });
});

describe('a boolean operand', () => {
  it.each([
    ['a string', written('true'), '&& takes a boolean, not a string'],
    ['null', nullOf, '&& takes a boolean, not null'],
    ['a null read through a reference', { ...nullOf, nullFrom: 'var.on' }, '&& takes a boolean, not null, and var.on, which it reads, is null'],
    ['a sensitive string', allSensitive(written('x')), '&& takes a boolean, and this sensitive value is not one; why is not shown'],
  ])('refuses %s', (_, value, message) => {
    const error = refusal(() => checkBoolean('&&', value, position));

    expect(error.message).toBe(message);
    expect(error.position).toEqual(position);
  });
});

describe('!', () => {
  it.each([
    [bool(true), bool(false)],
    [bool(false), bool(true)],
    [bool(UNKNOWN), bool(UNKNOWN)],
    [allSensitive(bool(true)), allSensitive(bool(false))],
  ])('turns %o into %o', (value, result) => {
    expect(negated(value)).toEqual(result);
  });
});
