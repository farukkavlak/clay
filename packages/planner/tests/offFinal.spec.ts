import { UNKNOWN } from '@clay/contracts';
import { describe, expect, it } from 'vitest';

import { offFinal } from '../src/index';

describe('offFinal', () => {
  it('takes anything where the plan did not know the value', () => {
    expect(offFinal({ id: UNKNOWN, tags: { a: UNKNOWN } }, { id: 'x', tags: { a: UNKNOWN } })).toEqual([]);
  });

  it('names a value the plan knew that the final plan does not', () => {
    expect(offFinal({ id: 'x' }, { id: UNKNOWN })).toEqual([{ path: ['id'], planned: 'x', returned: UNKNOWN }]);
  });

  it('names a known part of a list that comes to another', () => {
    expect(offFinal({ l: ['a', UNKNOWN] }, { l: ['b', 'c'] })).toEqual([{ path: ['l', 0], planned: 'a', returned: 'b' }]);
  });

  it('names a value the plan did not have', () => {
    expect(offFinal({}, { extra: 1 })).toEqual([{ path: ['extra'], planned: undefined, returned: 1 }]);
  });
});
