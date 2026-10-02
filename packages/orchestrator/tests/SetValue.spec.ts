import { describe, expect, it } from 'vitest';

import { plain, SetValue } from '../src/SetValue';

describe('plain', () => {
  it('makes a set in a list or a map a list', () => {
    expect(plain({ a: [new SetValue(['x'])] })).toEqual({ a: [['x']] });
  });

  it('makes a set inside a set a list', () => {
    expect(plain(new SetValue([new SetValue(['a'])]))).toEqual([['a']]);
  });
});
