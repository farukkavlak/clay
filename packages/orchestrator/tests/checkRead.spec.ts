import { Schema, UNKNOWN } from '@clay/contracts';
import { describe, expect, it } from 'vitest';

import { checkDataSourceRead, checkDataSourceSchema, checkRead, checkSchema } from '../src/providerResult';

const schema: Schema = { label: { type: 'string', required: true }, made: { type: 'string', computed: true } };
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
    ['forceNew', { label: { type: 'string', forceNew: true } }, 'label'],
    ['kept', { label: { type: 'string', computed: true, kept: true } }, 'label'],
    ['forceNew inside an object', { box: { type: 'object', schema: { lid: { type: 'string', forceNew: true } } } }, 'box.lid'],
  ] satisfies [string, Schema, string][])('is refused where a value is %s', (flag, given, at) => {
    const name = flag.split(' ')[0];

    expect(() => checkDataSourceSchema('echo', given)).toThrow(`data source echo marks ${at} ${name}, but only a resource can be ${name}, which is a bug in the provider`);
  });

  it('is taken as it is when it marks nothing a resource alone can be', () => {
    expect(checkDataSourceSchema('echo', schema)).toBe(schema);
  });
});

describe('a schema a provider gives', () => {
  it('is refused where a value inside an object is kept and not computed', () => {
    const nested: Schema = { box: { type: 'object', schema: { lid: { type: 'string', kept: true } } } };

    expect(() => checkSchema('echo', nested)).toThrow('echo keeps box.lid, which it does not compute; only a computed value can be kept, which is a bug in the provider');
  });
});
