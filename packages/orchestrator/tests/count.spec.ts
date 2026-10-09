import { ExactNumber, types, UNKNOWN } from '@clay/contracts';
import { describe, expect, it } from 'vitest';

import { countFrom } from '../src/count';
import { allSensitive, valueOf } from '../src/Value';

describe('the number of instances a count makes', () => {
  it.each([
    ['a sensitive number', allSensitive(valueOf(types.number, ExactNumber.parse('2')))],
    ['a sensitive number only an apply makes', allSensitive(valueOf(types.number, UNKNOWN))],
  ])('refuses %s, since a plan shows how many instances it makes', (_, value) => {
    expect(() => countFrom(value)).toThrow('count is sensitive: the number of instances shows what it is');
  });
});
