import { ExactNumber, Schema, types, UNKNOWN } from '@clay/contracts';
import { describe, expect, it } from 'vitest';

import { typed, typedValues, TypeMismatch } from '../src/typed';
import { plainOf, valueOf } from '../src/Value';

const n = (text: string) => ExactNumber.parse(text);

const schema: Schema = {
  names: { type: types.set(types.string) },
  ports: { type: types.list(types.number) },
  groups: { type: types.list(types.set(types.dynamic)) },
  byName: { type: types.map(types.set(types.dynamic)) },
  nested: { type: types.set(types.set(types.dynamic)) },
  rule: { type: types.object({ cidrs: types.set(types.string), note: types.string }, ['note']) },
  pair: { type: types.tuple([types.set(types.string), types.list(types.string)]) },
};

describe('plain data read as its type', () => {
  it('reads each value as the type the schema names', () => {
    expect(typedValues(schema, { ports: [n('443'), n('80')] })).toEqual({ ports: valueOf(types.list(types.number), [n('443'), n('80')]) });
  });

  it('orders a set inside a list, a map, an object and a tuple, and keeps the order of a list', () => {
    const read = typedValues(schema, {
      groups: [['b', 'a']],
      byName: { x: ['b', 'a'] },
      rule: { cidrs: ['b', 'a'] },
      pair: [
        ['b', 'a'],
        ['b', 'a'],
      ],
    });

    expect(Object.fromEntries(Object.entries(read).map(([name, value]) => [name, value.data]))).toEqual({
      groups: [['a', 'b']],
      byName: { x: ['a', 'b'] },
      rule: { cidrs: ['a', 'b'] },
      pair: [
        ['a', 'b'],
        ['b', 'a'],
      ],
    });
  });

  // The inner sets are ordered first, so the outer set sees one member.
  it('holds two inner sets with the same members as one member', () => {
    expect(typedValues(schema, { nested: [[{ b: 'x', a: 'y' }], [{ a: 'y', b: 'x' }]] }).nested.data).toEqual([[{ a: 'y', b: 'x' }]]);
  });

  it('keeps a set with a member not known yet, after the members it knows', () => {
    expect(typedValues(schema, { names: [UNKNOWN, 'b', 'a'] }).names.data).toEqual(['a', 'b', UNKNOWN]);
  });

  it('reads a value not known yet, or null, as one of the type its place names', () => {
    expect(typed(types.list(types.string), UNKNOWN, ['l'])).toEqual(valueOf(types.list(types.string), UNKNOWN));
    expect(typed(types.list(types.string), null, ['l'])).toEqual(valueOf(types.list(types.string), null));
  });

  // No declared type, so a list is a tuple and a map an object.
  it('gives a value of a dynamic type the type its shape has', () => {
    expect(typedValues({}, { meta: { a: ['x', n('1')] } }).meta.type).toEqual(types.object({ a: types.tuple([types.string, types.number]) }));
  });

  // A provider that spreads its input may return a name as undefined.
  it('takes a name given no value as one left out, at any depth', () => {
    const values = { ports: undefined, rule: { cidrs: [], note: undefined }, meta: { a: undefined, b: [{ c: undefined }] } };

    expect(plainOf(typedValues(schema, values))).toEqual({ rule: { cidrs: [] }, meta: { b: [{}] } });
    expect(typedValues(schema, values).meta.type).toEqual(types.object({ b: types.tuple([types.object({})]) }));
  });

  it('leaves out an optional attribute of an object', () => {
    expect(typed(schema.rule.type, { cidrs: [] }, ['rule']).data).toEqual({ cidrs: [] });
  });

  it.each([
    ['a string where it takes a list', { ports: 'x' }, 'ports is a string, where its type is a list'],
    ['a JavaScript number where it takes a number', { ports: [80] }, 'ports[0] is a JavaScript number, where its type is a number'],
    ['a list where it takes a map', { byName: [] }, 'byName is a list, where its type is a map'],
    ['a name an object does not have', { rule: { cidrs: [], other: 'x' } }, 'rule has "other", which its type does not'],
    ['an object without a name it requires', { rule: { note: 'x' } }, 'rule has no "cidrs", which its type requires'],
    ['a tuple of another length', { pair: [[]] }, 'pair holds 1 item, where its type has 2 items'],
    ['a JavaScript number where nothing names the type', { meta: 1 }, 'meta is a JavaScript number, which is no value Clay holds'],
    ['undefined in a list', { ports: [undefined] }, 'ports[0] is undefined, where its type is a number'],
    ['undefined in a list whose type nothing names', { meta: [undefined] }, 'meta[0] is undefined, which is no value Clay holds'],
  ])('refuses %s, named by the steps to it', (_, values, message) => {
    expect(() => typedValues(schema, values)).toThrow(new TypeMismatch(message));
  });
});
