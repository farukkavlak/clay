import { ExactNumber, Schema, UNKNOWN } from '@clay/contracts';
import { describe, expect, it } from 'vitest';

import { setsOrdered } from '../src/setOrder';

const n = (text: string) => ExactNumber.parse(text);

const schema: Schema = {
  names: { type: 'set', elemType: 'string' },
  anything: { type: 'set' },
  ports: { type: 'list', elemType: 'number' },
  groups: { type: 'list', elemType: 'set' },
  byName: { type: 'map', elemType: 'set' },
  rule: { type: 'object', schema: { cidrs: { type: 'set', elemType: 'string' } } },
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
    expect(setsOrdered(schema, { anything: [['a,b'], ['a', 'b']] })).toEqual({ anything: [['a', 'b'], ['a,b']] });
  });

  it('keeps the order of a list', () => {
    expect(setsOrdered(schema, { ports: [n('443'), n('80')] })).toEqual({ ports: [n('443'), n('80')] });
  });

  it('orders a set inside a list, a map and an object', () => {
    expect(setsOrdered(schema, { groups: [['b', 'a']], byName: { x: ['b', 'a'] }, rule: { cidrs: ['b', 'a'] } })).toEqual({
      groups: [['a', 'b']],
      byName: { x: ['a', 'b'] },
      rule: { cidrs: ['a', 'b'] },
    });
  });

  it('is not known while a member, or a value inside one, is not', () => {
    expect(setsOrdered(schema, { names: ['a', UNKNOWN], anything: [{ a: UNKNOWN }] })).toEqual({ names: UNKNOWN, anything: UNKNOWN });
  });
});
