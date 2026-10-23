import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it } from 'vitest';

import { ExactNumber, NumberError } from '../src/ExactNumber';
import { NestingError } from '../src/nesting';

const digits = (count: number) => '9'.repeat(count);
const number = (text: string) => ExactNumber.parse(text);
const nested = (levels: number) => `${'['.repeat(levels)}1${']'.repeat(levels)}`;

describe('ExactNumber', () => {
  it.each([
    ['0', '0'],
    ['42', '42'],
    ['12345678901234567890', '12345678901234567890'],
    ['9007199254740993', '9007199254740993'],
    ['007', '7'],
    ['1.50', '1.5'],
    ['0.001', '0.001'],
    ['-12.5', '-12.5'],
    ['1e3', '1000'],
    ['1.5e-2', '0.015'],
    ['-0', '0'],
  ])('keeps %s exactly, written as %s', (text, written) => {
    expect(ExactNumber.parse(text).toString()).toBe(written);
  });

  // The planner compares values structurally, so each number must have one form however it is written.
  it.each([
    ['1.50', '1.5'],
    ['1e3', '1000'],
    ['-0', '0'],
    ['007', '7'],
  ])('is the same value written as %s and as %s', (one, other) => {
    expect(isDeepStrictEqual(ExactNumber.parse(one), ExactNumber.parse(other))).toBe(true);
  });

  it('tells two numbers apart that JavaScript would round to one', () => {
    expect(isDeepStrictEqual(ExactNumber.parse('9007199254740992'), ExactNumber.parse('9007199254740993'))).toBe(false);
  });

  it.each(['', 'abc', '1.', '.5', '+1', '1e', 'NaN', 'Infinity', '1 000'])('refuses %j, which is no number', (text) => {
    expect(() => ExactNumber.parse(text)).toThrow(`"${text}" is not a number`);
  });

  // A thousand places either side of the point is more than any value needs, and caps the cost.
  describe('its reach', () => {
    it.each([
      ['a whole number of a thousand digits', digits(1000), digits(1000)],
      ['a power of ten a thousand places up', '1e999', `1${'0'.repeat(999)}`],
      ['a fraction a thousand places down', '1e-1000', `0.${'0'.repeat(999)}1`],
    ])('keeps %s', (_, text, written) => {
      expect(ExactNumber.parse(text).toString()).toBe(written);
    });

    it.each([
      ['a whole number of a thousand and one digits', digits(1001), `"${digits(20)}…" (1001 characters)`],
      ['a power of ten a thousand and one places up', '1e1000', '"1e1000"'],
      ['a fraction a thousand and one places down', '1e-1001', '"1e-1001"'],
      ['an exponent JavaScript would round', '1e9007199254740993', '"1e9007199254740993"'],
      ['an exponent JavaScript would call infinite', `1e${digits(400)}`, `"1e${digits(18)}…" (402 characters)`],
    ])('refuses %s', (_, text, quoted) => {
      expect(() => ExactNumber.parse(text)).toThrow(`${quoted} is out of range: a number reaches at most 1000 places either side of the point`);
    });
  });

  it.each([
    ['1', '2', -1],
    ['2', '1', 1],
    ['80', '443', -1],
    ['0.5', '0.25', 1],
    ['1.50', '1.5', 0],
    ['-1', '0', -1],
    ['0', '-1', 1],
    ['0', '0.0', 0],
    ['0', '0.5', -1],
    ['-0.5', '0', -1],
    ['-2', '-1', -1],
    ['-0.5', '-0.25', -1],
    ['1e3', '999.999', 1],
    ['12345678901234567890', '12345678901234567891', -1],
  ])('compares %s with %s as %d', (left, right, order) => {
    expect(Math.sign(ExactNumber.parse(left).compare(ExactNumber.parse(right)))).toBe(order);
  });

  describe('arithmetic', () => {
    it.each([
      ['1', '2', '3'],
      ['0.1', '0.2', '0.3'],
      ['1.5', '-1.5', '0'],
      ['9007199254740992', '1', '9007199254740993'],
      ['1e3', '0.001', '1000.001'],
      ['-2', '-0.25', '-2.25'],
    ])('adds %s and %s exactly into %s', (left, right, sum) => {
      expect(number(left).plus(number(right)).toString()).toBe(sum);
    });

    it.each([
      ['3', '5', '-2'],
      ['0.3', '0.1', '0.2'],
      ['-1', '-1', '0'],
      ['1e3', '1e-3', '999.999'],
    ])('takes %s minus %s as %s', (left, right, difference) => {
      expect(number(left).minus(number(right)).toString()).toBe(difference);
    });

    it.each([
      ['6', '7', '42'],
      ['0.1', '0.1', '0.01'],
      ['-2', '1.5', '-3'],
      ['-2', '-3', '6'],
      ['0', '-5', '0'],
      ['9007199254740993', '10', '90071992547409930'],
      ['2.5', '4', '10'],
    ])('multiplies %s by %s exactly into %s', (left, right, product) => {
      expect(number(left).times(number(right)).toString()).toBe(product);
    });

    it.each([
      ['5', '-5'],
      ['-0.5', '0.5'],
      ['0', '0'],
    ])('negates %s into %s', (text, negated) => {
      expect(number(text).negated().toString()).toBe(negated);
    });

    it('gives each result one form, as a number written so would have', () => {
      expect(isDeepStrictEqual(number('0.5').plus(number('0.5')), number('1'))).toBe(true);
      expect(isDeepStrictEqual(number('0').negated(), number('0'))).toBe(true);
    });

    it.each([
      ['a sum past a thousand places up', () => number(digits(1000)).plus(number('1')), '10000000000000000000… (1001 characters)'],
      ['a product past a thousand places up', () => number('1e999').times(number('10')), '10000000000000000000… (1001 characters)'],
      ['a product past a thousand places down', () => number('1e-1000').times(number('0.1')), '0.000000000000000000… (1003 characters)'],
    ])('refuses %s, as a number written past it is', (_, computed, shown) => {
      const problem = 'is out of range: a number reaches at most 1000 places either side of the point';

      expect(computed).toThrow(expect.objectContaining({ name: 'NumberError', message: `${shown} ${problem}`, problem }));
    });
  });

  // Callers catch NumberError and rethrow the rest, so every refusal must be one.
  it.each([
    ['a text that is no number', () => ExactNumber.parse('abc')],
    ['a number out of range', () => ExactNumber.parse('1e1000')],
    ['a fraction as an integer', () => ExactNumber.parse('1.5').toSafeInteger()],
    ['a number past 2^53 as an integer', () => ExactNumber.parse('9007199254740993').toSafeInteger()],
  ])('refuses %s with a NumberError', (_, refused) => {
    expect(refused).toThrow(NumberError);
  });

  it.each([
    ['a text that is no number', () => ExactNumber.parse('abc'), 'is not a number'],
    ['a number out of range', () => ExactNumber.parse('1e2000'), 'is out of range: a number reaches at most 1000 places either side of the point'],
    ['a fraction as an integer', () => ExactNumber.parse('1.5').toSafeInteger('count'), 'is not a whole number'],
  ])('names the problem apart from the number, for %s', (_, refused, problem) => {
    expect(refused).toThrow(expect.objectContaining({ problem }));
  });

  it('is written into JSON as the number it is, not rounded', () => {
    expect(JSON.stringify({ id: ExactNumber.parse('12345678901234567890'), list: [ExactNumber.parse('1.50')] })).toBe('{"id":12345678901234567890,"list":[1.5]}');
  });

  it('reads every number in JSON text exactly, however deep', () => {
    const read = ExactNumber.readJSON('{"id": 12345678901234567890, "list": [1.50, {"n": 9007199254740993}], "text": "42"}');

    expect(JSON.stringify(read)).toBe('{"id":12345678901234567890,"list":[1.5,{"n":9007199254740993}],"text":"42"}');
  });

  it('reads JSON text nested 500 levels deep, and refuses text nested deeper than the call stack holds', () => {
    expect(JSON.stringify(ExactNumber.readJSON(nested(500)))).toBe(nested(500));
    expect(() => ExactNumber.readJSON(nested(20_000))).toThrow(new NestingError(500));
  });

  describe('as a JavaScript integer', () => {
    it.each([
      ['42', 42],
      ['-3', -3],
      ['9007199254740991', 9_007_199_254_740_991],
      ['1e3', 1000],
    ])('gives %s as %d', (text, value) => {
      expect(ExactNumber.parse(text).toSafeInteger()).toBe(value);
    });

    it.each(['9007199254740992', '-9007199254740992'])('refuses %s, which JavaScript would round', (text) => {
      expect(() => ExactNumber.parse(text).toSafeInteger()).toThrow(`${text} is outside the range -9007199254740991 to 9007199254740991`);
    });

    it('refuses a number that is not whole', () => {
      expect(() => ExactNumber.parse('1.5').toSafeInteger()).toThrow('1.5 is not a whole number');
    });

    // The refusal is read far from the number, so the caller labels it.
    it('names what the number is, when told', () => {
      expect(() => ExactNumber.parse('1.5').toSafeInteger('its serial')).toThrow('its serial: 1.5 is not a whole number');
    });

    it('does not write a long number out in full when refusing it', () => {
      expect(() => ExactNumber.parse(digits(900)).toSafeInteger()).toThrow(`${digits(20)}… (900 characters) is outside the range -9007199254740991 to 9007199254740991`);
    });
  });
});
