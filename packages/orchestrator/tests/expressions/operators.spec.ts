import { ExactNumber, Marks, types, UNKNOWN } from '@clay/contracts';
import { ConfigError } from '@clay/parser';
import { describe, expect, it } from 'vitest';

import { arithmetic, asNumber, checkBoolean, equality, negated, negative, NumberValue, ordering } from '../../src/expressions/operators';
import { allSensitive, inferred, Value, valueOf, withSensitive } from '../../src/values/Value';

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

  it('names the types when a side is sensitive', () => {
    expect(refusal(() => equal(allSensitive(written(number('1'))), written('a'))).message).toBe('== compares a number with a string, which are never equal');
  });

  it('names no item when a side is sensitive, since a for can make its keys', () => {
    expect(refusal(() => equal(allSensitive(written({ k: number('1') })), written({ k: 'a' }))).message).toBe(
      '== compares an object with an object whose items differ in type; one is sensitive, so no more is shown'
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
    ['a sensitive string', allSensitive(written('x')), '&& takes a boolean, not a string'],
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

const numeric = (text: string | typeof UNKNOWN): NumberValue => ({ ...valueOf(types.number, null), data: text === UNKNOWN ? UNKNOWN : number(text) });

const secretNumber = (text: string): NumberValue => ({ ...numeric(text), marks: Marks.of([[]]) });

describe('a number operand', () => {
  it.each([
    ['a number', numeric('1.5'), numeric('1.5')],
    ['a string that spells one', written('8'), numeric('8')],
    ['a string with an exponent', written('1e3'), numeric('1000')],
    ['a number not known yet', numeric(UNKNOWN), numeric(UNKNOWN)],
    ['a string not known yet', valueOf(types.string, UNKNOWN), numeric(UNKNOWN)],
    ['a value of no type not known yet', valueOf(types.dynamic, UNKNOWN), numeric(UNKNOWN)],
    ['a sensitive string', allSensitive(written('8')), allSensitive(numeric('8'))],
  ])('takes %s', (_, value, taken) => {
    expect(asNumber('+', value, position)).toEqual(taken);
  });

  it.each([
    ['a string that spells none', written('8 MB'), '+ takes a number, and "8 MB" is not a number'],
    ['a sensitive string that spells none', allSensitive(written('8 MB')), '+ takes a number, and (sensitive value) is not a number'],
    ['a string past the reach', written('1e5000'), '+ takes a number, and "1e5000" is out of range: a number reaches at most 1000 places either side of the point'],
    ['a boolean', bool(true), '+ takes a number, not a boolean'],
    ['a boolean of no type', valueOf(types.dynamic, true), '+ takes a number, not a boolean'],
    ['a tuple', written([number('1')]), '+ takes a number, not a tuple'],
    ['null', nullOf, '+ takes a number, not null'],
    ['a null read through a reference', { ...nullOf, nullFrom: 'var.n' }, '+ takes a number, not null, and var.n, which it reads, is null'],
    ['a sensitive tuple', allSensitive(written([])), '+ takes a number, not a tuple'],
  ])('refuses %s', (_, value, message) => {
    const error = refusal(() => asNumber('+', value, position));

    expect(error.message).toBe(message);
    expect(error.position).toEqual(position);
  });
});

describe('arithmetic', () => {
  it.each([
    ['+', '1.5', '2', '3.5'],
    ['-', '1', '2.5', '-1.5'],
    ['*', '-1.5', '4', '-6'],
    ['/', '1', '4', '0.25'],
    ['/', '2', '3', '0.6666666666666666666666666666666667'],
    ['%', '-7', '3', '-1'],
  ] as const)('works out %s on %s and %s as %s', (operator, left, right, result) => {
    expect(arithmetic(operator, numeric(left), numeric(right), position)).toEqual(numeric(result));
  });

  it.each([
    ['the left', numeric(UNKNOWN), numeric('1')],
    ['the right', numeric('1'), numeric(UNKNOWN)],
  ])('leaves the result to the apply where %s is not known yet', (_, left, right) => {
    expect(arithmetic('+', left, right, position)).toEqual(numeric(UNKNOWN));
  });

  it.each([
    ['the left', secretNumber('1'), numeric('2')],
    ['the right', numeric('1'), secretNumber('2')],
  ])('makes the result sensitive where %s is', (_, left, right) => {
    expect(arithmetic('*', left, right, position)).toEqual(allSensitive(numeric('2')));
  });

  it.each(['/', '%'] as const)('refuses %s by zero, at the operator', (operator) => {
    const error = refusal(() => arithmetic(operator, numeric('1'), numeric('0.0'), position));

    expect(error.message).toBe(`${operator} divides by zero, which has no result`);
    expect(error.position).toEqual(position);
  });

  it('refuses a sensitive divisor of zero without saying why', () => {
    const error = refusal(() => arithmetic('/', numeric('1'), secretNumber('0'), position));

    expect(error.message).toBe('/ cannot divide by this sensitive value; why is not shown');
  });

  it('leaves a division to the apply while the divisor is not known yet', () => {
    expect(arithmetic('/', numeric('1'), numeric(UNKNOWN), position)).toEqual(numeric(UNKNOWN));
  });

  it('refuses a result past the reach without naming it, since a side may be sensitive', () => {
    const error = refusal(() => arithmetic('*', secretNumber('1e999'), numeric('10'), position));

    expect(error.message).toBe('What * gives is out of range: a number reaches at most 1000 places either side of the point');
    expect(error.position).toEqual(position);
  });
});

describe('ordering', () => {
  it.each([
    ['<', '1', '2', true],
    ['<', '2', '2', false],
    ['>', '2', '1', true],
    ['>', '2', '2', false],
    ['<=', '2', '2.0', true],
    ['<=', '3', '2', false],
    ['>=', '2', '2', true],
    ['>=', '-1', '0', false],
    ['<', '9007199254740992', '9007199254740993', true],
  ] as const)('answers %s for %s and %s as %s', (operator, left, right, answer) => {
    expect(ordering(operator, numeric(left), numeric(right), position)).toEqual(bool(answer));
  });

  it('leaves the answer to the apply where a side is not known yet, and makes it sensitive where a side is', () => {
    expect(ordering('<', numeric(UNKNOWN), numeric('1'), position)).toEqual(bool(UNKNOWN));
    expect(ordering('<', secretNumber('1'), numeric('2'), position)).toEqual(allSensitive(bool(true)));
    expect(ordering('<', numeric('1'), secretNumber('2'), position)).toEqual(allSensitive(bool(true)));
  });
});

describe('-', () => {
  it.each([
    [numeric('2'), numeric('-2')],
    [numeric('-0.5'), numeric('0.5')],
    [numeric(UNKNOWN), numeric(UNKNOWN)],
    [secretNumber('2'), allSensitive(numeric('-2'))],
  ])('turns %o into %o', (value, result) => {
    expect(negative(value)).toEqual(result);
  });
});
