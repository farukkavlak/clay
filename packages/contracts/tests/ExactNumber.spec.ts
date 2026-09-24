import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it } from 'vitest';

import { ExactNumber } from '../src/ExactNumber';

const digits = (count: number) => '9'.repeat(count);

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

  // The planner compares values structurally, so one number has to come out the same however it was written.
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

  // A place is a digit's distance from the point; a thousand either side is more than any value needs, and bounds what one can cost.
  describe('its reach', () => {
    it.each([
      ['a whole number of a thousand digits', digits(1000), digits(1000)],
      ['a power of ten a thousand places up', '1e999', `1${'0'.repeat(999)}`],
      ['a fraction a thousand places down', '1e-1000', `0.${'0'.repeat(999)}1`],
    ])('keeps %s', (_, text, written) => {
      expect(ExactNumber.parse(text).toString()).toBe(written);
    });

    it.each([
      ['a whole number of a thousand and one digits', digits(1001)],
      ['a power of ten a thousand and one places up', '1e1000'],
      ['a fraction a thousand and one places down', '1e-1001'],
      ['an exponent JavaScript would round', '1e9007199254740993'],
      ['an exponent JavaScript would call infinite', `1e${digits(400)}`],
    ])('refuses %s', (_, text) => {
      expect(() => ExactNumber.parse(text)).toThrow(`"${text}" is out of range: a number reaches at most 1000 places either side of the point`);
    });
  });

  it('is written into JSON as the number it is, not rounded', () => {
    expect(JSON.stringify({ id: ExactNumber.parse('12345678901234567890'), list: [ExactNumber.parse('1.50')] })).toBe('{"id":12345678901234567890,"list":[1.5]}');
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
      expect(() => ExactNumber.parse(text).toSafeInteger()).toThrow(`${text} is outside the range a whole number can have here, -9007199254740991 to 9007199254740991`);
    });

    it('refuses a number that is not whole', () => {
      expect(() => ExactNumber.parse('1.5').toSafeInteger()).toThrow('1.5 is not a whole number');
    });
  });
});
