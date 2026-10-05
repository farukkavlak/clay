import { types, UNKNOWN } from '@clay/contracts';
import { describe, expect, it } from 'vitest';

import { offPlan } from '../src/index';

describe('a value held to the plan', () => {
  it('holds a map whose keys come in another order', () => {
    expect(offPlan({}, { tags: { a: '1', b: '2' } }, { tags: { b: '2', a: '1' } })).toBeUndefined();
  });

  // Every object inherits `constructor`, so only an own key counts as planned.
  it('names a value the plan did not have as nothing planned, whatever its name', () => {
    expect(offPlan({}, {}, { constructor: 'x' })).toEqual({ name: 'constructor', planned: undefined, resolved: 'x' });
  });

  it('holds a set whose member not known yet sorts among the others', () => {
    expect(offPlan({ members: { type: types.set(types.string) } }, { members: ['b', UNKNOWN] }, { members: ['a', 'b'] })).toBeUndefined();
  });
});
