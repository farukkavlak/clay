import { InMemoryFiles } from '@clay/orchestrator';
import { describe, expect, it } from 'vitest';

import { givenFiles } from '../src/givenFiles';

describe('givenFiles', () => {
  const files = new InMemoryFiles({ 'main.clay': 'variable "x" {}', 'f.clayvars': 'x = "on disk now"' });

  it('reads each value given from outside as the file an error in it names', () => {
    const given = givenFiles(files, [
      { from: 'var', name: 'x', text: 'flag' },
      { from: 'env', name: 'x', text: 'env' },
      { from: 'file', file: 'f.clayvars', text: 'x = "as read"' },
    ]);

    expect([given.read('--var x'), given.read('CLAY_VAR_x'), given.read('f.clayvars')]).toEqual(['flag', 'env', 'x = "as read"']);
  });

  it('reads any other file from the configuration', () => {
    expect(givenFiles(files, []).read('main.clay')).toBe('variable "x" {}');
  });
});
