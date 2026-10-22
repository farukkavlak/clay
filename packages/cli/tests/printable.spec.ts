import { describe, expect, it } from 'vitest';

import { printable } from '../src/printable';

describe('printable', () => {
  it.each([
    ['an escape, which starts a terminal sequence', 'a\u001B[2Jb', 'a\u241B[2Jb'],
    ['a carriage return inside a line', 'abc\rXY', 'abc\u240DXY'],
    ['a null and a bell', '\u0000\u0007', '\u2400\u2407'],
    ['a delete', 'a\u007F', 'a\u2421'],
    ['a C1 control', 'a\u009Bb', 'a\uFFFDb'],
    ['a direction override', 'a\u202Eb\u2066c', 'a\uFFFDb\uFFFDc'],
    ['a direction mark', 'a\u200Fb\u061Cc\u200E', 'a\uFFFDb\uFFFDc\uFFFD'],
  ])('shows %s as a character of its own', (_, text, shown) => {
    expect(printable(text)).toBe(shown);
  });

  it('keeps tabs and line feeds, and a carriage return that ends a line', () => {
    expect(printable('a\tb\r\nc\nd')).toBe('a\tb\nc\nd');
  });

  it('keeps text with no control in it as it is', () => {
    expect(printable('Invalid name "\u65E5\u672C" \u{1F680} \u200D')).toBe('Invalid name "\u65E5\u672C" \u{1F680} \u200D');
  });
});
