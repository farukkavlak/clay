import { Schema, types, UNKNOWN } from '@clay/contracts';
import { describe, expect, it } from 'vitest';

import { checkDataSourceRead, checkDataSourceSchema, checkRead, checkSchema } from '../src/providerResult';

const schema: Schema = { label: { type: types.string, required: true }, made: { type: types.string, computed: true } };
const bug = 'echo read what the resource cannot hold, which is a bug in the provider:';

describe('what a provider read back', () => {
  it('takes what the schema has', () => {
    expect(() => checkRead('echo', schema, { label: 'b', made: 'm' })).not.toThrow();
  });

  it('refuses a name the schema does not have', () => {
    expect(() => checkRead('echo', schema, { label: 'a', volume: 'high' })).toThrow(`${bug}\n  volume = "high", which the schema does not have`);
  });

  it('refuses a value not known, where it is', () => {
    expect(() => checkRead('echo', schema, { label: 'a', made: { at: [UNKNOWN] } })).toThrow(`${bug}\n  made["at"][0] is not known; a read returns every value`);
  });

  // Every object answers to `constructor`, so the schema has to hold the name itself to have it.
  it('refuses a name the schema does not have, whatever its name', () => {
    expect(() => checkRead('echo', schema, { constructor: 'x' })).toThrow(`${bug}\n  constructor = "x", which the schema does not have`);
  });

  it('names every value it cannot hold', () => {
    expect(() => checkRead('echo', schema, { a: '1', b: UNKNOWN })).toThrow(`${bug}\n  a = "1", which the schema does not have\n  b is not known; a read returns every value`);
  });
});

describe('what a data source read', () => {
  const read = 'echo read what the data source cannot hold, which is a bug in the provider:';

  it('refuses a value not known, where it is', () => {
    expect(() => checkDataSourceRead('echo', schema, { label: '1', made: { c: UNKNOWN } })).toThrow(`${read}\n  made["c"] is not known; a read returns every value`);
  });

  it('refuses a name the schema does not have', () => {
    expect(() => checkDataSourceRead('echo', schema, { label: 'a', volume: 'high' })).toThrow(`${read}\n  volume = "high", which the schema does not have`);
  });
});

describe('a schema a data source gives', () => {
  it.each([
    ['forceNew', { label: { type: types.string, forceNew: true } }],
    ['kept', { label: { type: types.string, computed: true, kept: true } }],
  ] satisfies [string, Schema][])('is refused where a value is %s', (flag, given) => {
    expect(() => checkDataSourceSchema('echo', given)).toThrow(`data source echo marks label ${flag}, but only a resource can be ${flag}, which is a bug in the provider`);
  });

  it('is taken as it is when it marks nothing a resource alone can be', () => {
    expect(checkDataSourceSchema('echo', schema)).toBe(schema);
  });
});

describe('a schema a provider gives', () => {
  it('is refused where a value is kept and not computed', () => {
    const given: Schema = { lid: { type: types.string, kept: true } };

    expect(() => checkSchema('echo', given)).toThrow('echo keeps lid, which it does not compute; only a computed value can be kept, which is a bug in the provider');
  });

  it.each([
    ['required', { type: types.bool, required: true, default: false }, 'echo gives lid a default, but it is required, which is a bug in the provider'],
    ['computed', { type: types.bool, computed: true, optional: true, default: false }, 'echo gives lid a default, but it computes it, which is a bug in the provider'],
    ['of another type', { type: types.bool, default: 'no' }, 'echo gives lid a default its type does not hold, which is a bug in the provider'],
    ['null', { type: types.bool, default: null }, 'echo gives lid a default of null, which is a bug in the provider'],
    ['not known', { type: types.string, default: UNKNOWN }, 'echo gives lid a default that is not known, which is a bug in the provider'],
    ['a set out of order', { type: types.set(types.string), default: ['b', 'a'] }, 'echo gives lid a default its type holds as ["a","b"], which is a bug in the provider'],
    [
      'an object short of an optional attribute',
      { type: types.object({ a: types.string, b: types.string }, ['b']), default: { a: 'x' } },
      'echo gives lid a default its type holds as {"a":"x","b":null}, which is a bug in the provider',
    ],
  ])('is refused where a default is %s', (_, definition, message) => {
    expect(() => checkSchema('echo', { lid: definition })).toThrow(message);
  });

  it('takes a default its type holds', () => {
    const given: Schema = { lid: { type: types.bool, default: false } };

    expect(checkSchema('echo', given)).toBe(given);
  });

  it('is refused for a data source with a default, which is never planned', () => {
    const given: Schema = { lid: { type: types.bool, default: false } };

    expect(() => checkDataSourceSchema('echo', given)).toThrow('data source echo gives lid a default, but only a resource can have one, which is a bug in the provider');
  });
});

// A provider written in JavaScript has no type check, and a saved plan with such a type would be refused as a broken file.
describe('a type a schema gives', () => {
  const broken = { box: { type: { kind: 'object', attributes: { lid: types.string }, optional: ['lip'] } } } as unknown as Schema;

  it.each([
    ['a resource', () => checkSchema('echo', broken), 'echo'],
    ['a data source', () => checkDataSourceSchema('echo', broken), 'data source echo'],
  ])('is refused for %s when it is not whole', (_, check, named) => {
    expect(check).toThrow(`${named} gives box a type Clay cannot read, which is a bug in the provider`);
  });
});
