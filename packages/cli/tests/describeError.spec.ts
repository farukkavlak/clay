import { ConfigFiles, InMemoryFiles } from '@clay/orchestrator';
import { ConfigError } from '@clay/parser';
import { describe, expect, it } from 'vitest';

import { describeError } from '../src/describeError';

const error = new ConfigError('Invalid name "a.b"', { file: 'main.clay', line: 1, column: 5 });

const failingWith = (thrown: Error): ConfigFiles => ({
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

  it('lets a failure that is no file error through, rather than hide it behind the one being shown', () => {
    const files = failingWith(new TypeError('not a file problem'));

    expect(() => describeError(error, files)).toThrow('not a file problem');
  });
});
