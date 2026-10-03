import { ExactNumber, Schema, types, UNKNOWN } from '@clay/contracts';
import { describe, expect, it } from 'vitest';

import { setsMarked, setsOrdered } from '../src/setOrder';
import { SetValue } from '../src/SetValue';

const n = (text: string) => ExactNumber.parse(text);

const schema: Schema = {
  names: { type: types.set(types.string) },
  anything: { type: types.set(types.dynamic) },
  ports: { type: types.list(types.number) },
  groups: { type: types.list(types.set(types.dynamic)) },
  byName: { type: types.map(types.set(types.dynamic)) },
  nested: { type: types.set(types.set(types.dynamic)) },
  rule: { type: types.object({ cidrs: types.set(types.string) }) },
  pair: { type: types.tuple([types.set(types.string), types.list(types.string)]) },
};

describe('setsOrdered', () => {
  it('holds the members of a set in one order, however they were written', () => {
    expect(setsOrdered(schema, { names: ['b', 'c', 'a'] })).toEqual(setsOrdered(schema, { names: ['c', 'a', 'b'] }));
  });

  it('orders numbers by their value', () => {
    expect(setsOrdered(schema, { anything: [n('443'), n('-1'), n('80'), n('0.5')] })).toEqual({ anything: [n('-1'), n('0.5'), n('80'), n('443')] });
  });

  it('holds a member written twice once', () => {
    expect(setsOrdered(schema, { names: ['a', 'b', 'a'] })).toEqual({ names: ['a', 'b'] });
  });

  it('holds two maps with the same keys and values as one member, whatever order their keys are in', () => {
    expect(
      setsOrdered(schema, {
        anything: [
          { a: '1', b: '2' },
          { b: '2', a: '1' },
        ],
      })
    ).toEqual({ anything: [{ a: '1', b: '2' }] });
  });

  it('tells a string from the number or the boolean it spells', () => {
    expect(setsOrdered(schema, { anything: [true, n('1'), 'true', '#1'] })).toEqual({ anything: ['#1', 'true', n('1'), true] });
  });

  it('tells a list from one whose items would join into the same text', () => {
    expect(setsOrdered(schema, { anything: [[['a'], ['b']], [['a', 'b']]] })).toEqual({ anything: [[['a', 'b']], [['a'], ['b']]] });
  });

  it('tells a map from one whose keys would join into the same text', () => {
    const joined = { 'a:"x",b': '1' };

    expect(setsOrdered(schema, { anything: [{ a: 'x', b: '1' }, joined] }).anything).toEqual(expect.arrayContaining([{ a: 'x', b: '1' }, joined]));
  });

  it('keeps the order of a list', () => {
    expect(setsOrdered(schema, { ports: [n('443'), n('80')] })).toEqual({ ports: [n('443'), n('80')] });
  });

  it('orders a set inside a list, a map, an object and a tuple', () => {
    expect(
      setsOrdered(schema, {
        groups: [['b', 'a']],
        byName: { x: ['b', 'a'] },
        rule: { cidrs: ['b', 'a'] },
        pair: [
          ['b', 'a'],
          ['b', 'a'],
        ],
      })
    ).toEqual({
      groups: [['a', 'b']],
      byName: { x: ['a', 'b'] },
      rule: { cidrs: ['a', 'b'] },
      pair: [
        ['a', 'b'],
        ['b', 'a'],
      ],
    });
  });

  // A provider answer that does not match its own type is refused by the read check, not put in order here.
  it('leaves a record where a list is named as it is', () => {
    expect(setsOrdered(schema, { groups: { a: ['b', 'a'] } })).toEqual({ groups: { a: ['b', 'a'] } });
  });

  it('is not known while a member, or a value inside one, is not', () => {
    expect(setsOrdered(schema, { names: ['a', UNKNOWN], anything: [{ a: UNKNOWN }] })).toEqual({ names: UNKNOWN, anything: UNKNOWN });
  });
});

describe('setsMarked', () => {
  it('makes each set a SetValue, in the order setsOrdered holds it', () => {
    expect(setsMarked(schema, { names: ['b', 'a', 'b'] })).toEqual({ names: new SetValue(['a', 'b']) });
  });

  // The inner sets are marked first, so the outer set compares SetValues; read as anything else, the same two would be two members.
  it('holds two inner sets with the same members as one member', () => {
    const nested = [[{ b: 'x', a: 'y' }], [{ a: 'y', b: 'x' }]];

    expect(setsMarked(schema, { nested })).toEqual({ nested: new SetValue([new SetValue([{ a: 'y', b: 'x' }])]) });
  });
});
