import { ConfigFiles, InMemoryFiles } from '@clay/orchestrator';
import { ConfigError } from '@clay/parser';
import { describe, expect, it } from 'vitest';

import { describeError } from '../src/describeError';

const error = new ConfigError('Invalid name "a.b"', { file: 'main.clay', line: 1, column: 5 });

const failingWith = (thrown: Error): ConfigFiles => ({
  list: () => [],
  read: () => {
    throw thrown;
  },
});

describe('describeError', () => {
  // The file may be gone or broken by the time the error is shown.
  it('still says what went wrong and where when the file cannot be read again', () => {
    const files = failingWith(Object.assign(new Error('ELOOP: too many symbolic links'), { code: 'ELOOP' }));

    expect(describeError(error, files)).toBe('Invalid name "a.b"\n\n  on main.clay line 1:');
  });

  it('shows the line of a file whose line breaks are CRLF without the carriage return', () => {
    const files = new InMemoryFiles({ 'main.clay': 'first\r\nx = "abc\r\nlast\r\n' });
    const onLine2 = new ConfigError('This string is never closed', { file: 'main.clay', line: 2, column: 5 });

    expect(describeError(onLine2, files)).toContain('\n  2: x = "abc\n         ^');
  });

  // The column counts code points, which is not how wide a line shows.
  it.each([
    ['tabs, as tabs', '\t\tx = y', '\t\t    '],
    ['wide characters, as two cells each', 'x = "日あア가" y', '     ' + '        ' + '  '],
    ['CJK punctuation and a fullwidth letter, as two cells each', 'x = "、Ａ" y', '     ' + '    ' + '  '],
    ['halfwidth kana, as one cell', 'x = "ｱ" y', '     ' + ' ' + '  '],
    ['an emoji, as two cells', 'x = "🚀" y', '     ' + '  ' + '  '],
    ['a text character shown as an emoji, as two cells', 'x = "❤\uFE0F" y', '     ' + '  ' + '  '],
    ['a letter with a combining accent, as one cell', 'x = "e\u0301" y', '     ' + ' ' + '  '],
    ['emoji joined into one, as one emoji', 'x = "👩\u200D💻" y', '     ' + '  ' + '  '],
  ])('lines the caret up under %s', (_, line, blank) => {
    const files = new InMemoryFiles({ 'main.clay': line });
    const atY = new ConfigError('Unknown name "y"', { file: 'main.clay', line: 1, column: [...line].indexOf('y') + 1 });

    expect(describeError(atY, files)).toContain(`\n  1: ${line}\n     ${blank}^`);
  });

  // The lexer can refuse a combining mark of its own, a column into the character it joins.
  it('puts the caret under the whole character when the column points inside it', () => {
    const files = new InMemoryFiles({ 'main.clay': 'xe\u0301' });
    const atAccent = new ConfigError('Unexpected character', { file: 'main.clay', line: 1, column: 3 });

    expect(describeError(atAccent, files)).toContain('\n  1: xe\u0301\n      ^');
  });

  // A control character would move the cursor or start a terminal sequence, so the line would not show as it is.
  it.each([
    ['a carriage return', 'x = "a\rb" y', 'x = "a\u240Db" y', 10],
    ['an escape in a comment', 'x = y # \u001B[2J', 'x = y # \u241B[2J', 4],
    ['a direction override', 'x = "\u202Eab" y', 'x = "\uFFFDab" y', 10],
    ['a control joined by a combining accent', 'x = "a\u0007\u0301" y', 'x = "a\u2407\u0301" y', 9],
    ['a control joined by a zero width joiner', 'x = "a\u0007\u200D" y', 'x = "a\u2407\u200D" y', 9],
  ])('shows %s in the line as a character of its own, with the caret under the same column', (_, line, shown, before) => {
    const files = new InMemoryFiles({ 'main.clay': line });
    const atY = new ConfigError('Unknown name "y"', { file: 'main.clay', line: 1, column: [...line].indexOf('y') + 1 });

    expect(describeError(atY, files)).toContain(`\n  1: ${shown}\n     ${' '.repeat(before)}^`);
  });

  it('shows a control character in the message as a character of its own', () => {
    const files = new InMemoryFiles({ 'main.clay': '\u001B' });
    const atEscape = new ConfigError('Unexpected character: "\u001B"', { file: 'main.clay', line: 1, column: 1 });

    expect(describeError(atEscape, files)).toBe('Unexpected character: "\u241B"\n\n  on main.clay line 1:\n\n  1: \u241B\n     ^');
    expect(describeError(new Error('\u001B[31mx.clay is listed but not found'), files)).toBe('\u241B[31mx.clay is listed but not found');
  });

  it('lets a failure that is no file error through, rather than hide it behind the one being shown', () => {
    const files = failingWith(new TypeError('not a file problem'));

    expect(() => describeError(error, files)).toThrow('not a file problem');
  });
});
