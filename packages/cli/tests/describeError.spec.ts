import { ConfigFiles } from '@clay/orchestrator';
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
  // The file was read once to find the error; it may be gone or broken by the time the error is shown.
  it('still says what went wrong and where when the file cannot be read again', () => {
    const files = failingWith(Object.assign(new Error('ELOOP: too many symbolic links'), { code: 'ELOOP' }));

    expect(describeError(error, files)).toBe('Invalid name "a.b"\n\n  on main.clay line 1:');
  });

  it('lets a failure that is no file error through, rather than hide it behind the one being shown', () => {
    const files = failingWith(new TypeError('not a file problem'));

    expect(() => describeError(error, files)).toThrow('not a file problem');
  });
});
