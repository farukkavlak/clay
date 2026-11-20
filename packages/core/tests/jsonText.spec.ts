import { describe, expect, it } from 'vitest';

import { jsonText } from '../src/jsonText';

const RAW = '\u007F\u0085\u061C\u200E\u200F\u202A\u202E\u2066\u2069';

describe('jsonText', () => {
  it('escapes DEL, C1 and every direction control JSON.stringify leaves raw', () => {
    expect(jsonText(RAW)).toBe(String.raw`"\u007f\u0085\u061c\u200e\u200f\u202a\u202e\u2066\u2069"`);
  });

  it('escapes them in a key as in a value, and reads back as the same value', () => {
    const value = { [RAW]: [RAW] };

    expect(JSON.parse(jsonText(value))).toEqual(value);
  });

  it('leaves the characters that are not controls as they are', () => {
    expect(jsonText('a\u00A0ü\u202Fb')).toBe('"a\u00A0ü\u202Fb"');
  });

  it('indents as asked', () => {
    expect(jsonText({ a: 1 }, 2)).toBe('{\n  "a": 1\n}');
  });
});
