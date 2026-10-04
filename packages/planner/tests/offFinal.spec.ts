import { Schema, types, UNKNOWN } from '@clay/contracts';
import { describe, expect, it } from 'vitest';

import { offFinal } from '../src/index';

describe('offFinal', () => {
  it('takes anything where the plan did not know the value', () => {
    expect(offFinal({}, { id: UNKNOWN, tags: { a: UNKNOWN } }, { id: 'x', tags: { a: UNKNOWN } })).toEqual([]);
  });

  it('names a value the plan knew that the final plan does not', () => {
    expect(offFinal({}, { id: 'x' }, { id: UNKNOWN })).toEqual([{ path: ['id'], planned: 'x', returned: UNKNOWN }]);
  });

  it('names a known part of a list that comes to another', () => {
    expect(offFinal({}, { l: ['a', UNKNOWN] }, { l: ['b', 'c'] })).toEqual([{ path: ['l', 0], planned: 'a', returned: 'b' }]);
  });

  it('names a value the plan did not have', () => {
    expect(offFinal({}, {}, { extra: 1 })).toEqual([{ path: ['extra'], planned: undefined, returned: 1 }]);
  });
});

// A set's members have no place, so a member the plan did not know may sort anywhere, or come to one the set already has.
describe('a set held to the plan', () => {
  const schema: Schema = {
    members: { type: types.set(types.string) },
    groups: { type: types.list(types.set(types.string)) },
    named: { type: types.map(types.set(types.string)) },
  };

  it.each([
    ['a member not known that sorts before one the plan knew', { members: ['b', UNKNOWN] }, { members: ['a', 'b'] }],
    ['a member not known that came to one the set already has', { members: ['a', UNKNOWN] }, { members: ['a'] }],
    ['two members not known that came to one', { members: ['a', UNKNOWN, UNKNOWN] }, { members: ['a', 'b'] }],
    ['a set inside a list', { groups: [['b', UNKNOWN]] }, { groups: [['a', 'b']] }],
    ['a set inside a map', { named: { x: ['b', UNKNOWN] } }, { named: { x: ['a', 'b'] } }],
  ])('holds %s', (_, planned, final) => {
    expect(offFinal(schema, planned, final)).toEqual([]);
  });

  it.each([
    ['without a member the plan knew', { members: ['a', UNKNOWN] }, { members: ['b', 'c'] }],
    ['with more members than the plan could make', { members: ['a', UNKNOWN] }, { members: ['a', 'b', 'c'] }],
    ['with another member, where the plan knew them all', { members: ['a', 'b'] }, { members: ['a', 'c'] }],
    ['that is not a set', { members: ['a', UNKNOWN] }, { members: 'a' }],
    ['without a member the plan knew, though no larger than planned', { members: ['z', UNKNOWN] }, { members: ['a'] }],
  ])('names a set %s, as a whole', (_, planned, final) => {
    expect(offFinal(schema, planned, final)).toEqual([{ path: ['members'], planned: planned.members, returned: final.members }]);
  });
});
