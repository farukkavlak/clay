import { Schema, UNKNOWN } from '@clay/contracts';
import { describe, expect, it } from 'vitest';

import { checkDataSourceRead, checkRead, checkSchema } from '../src/providerResult';

const schema: Schema = { label: { type: 'string', required: true }, made: { type: 'string', computed: true } };
const bug = 'echo read what the resource cannot hold, which is a bug in the provider:';

describe('what a provider read back', () => {
  it('takes what the schema has', () => {
    expect(() => checkRead('echo', schema, { label: 'a' }, { label: 'b', made: 'm' })).not.toThrow();
  });

  // Nothing checks a configuration against the schema yet, so state may hold a name the configuration set.
  it('takes a name the schema does not have and the resource already held', () => {
    expect(() => checkRead('echo', schema, { label: 'a', bogus: '1' }, { label: 'a', bogus: '1' })).not.toThrow();
  });

  it('refuses a name neither the schema nor the resource has', () => {
    expect(() => checkRead('echo', schema, { label: 'a' }, { label: 'a', volume: 'high' })).toThrow(`${bug}\n  volume = "high", which neither the schema nor the resource has`);
  });

  it('refuses a value not known, where it is', () => {
    expect(() => checkRead('echo', schema, { label: 'a' }, { label: 'a', made: { at: [UNKNOWN] } })).toThrow(`${bug}\n  made["at"][0] is not known; a read returns every value`);
  });

  // Every object answers to `constructor`, so the schema has to hold the name itself to have it.
  it('refuses a name the schema does not have, whatever its name', () => {
    expect(() => checkRead('echo', schema, {}, { constructor: 'x' })).toThrow(`${bug}\n  constructor = "x", which neither the schema nor the resource has`);
  });

  it('names every value it cannot hold', () => {
    expect(() => checkRead('echo', schema, {}, { a: '1', b: UNKNOWN })).toThrow(
      `${bug}\n  a = "1", which neither the schema nor the resource has\n  b is not known; a read returns every value`
    );
  });
});

describe('what a data source read', () => {
  it('refuses a value not known, where it is', () => {
    expect(() => checkDataSourceRead('echo', { a: '1', b: { c: UNKNOWN } })).toThrow(
      'echo read what the data source cannot hold, which is a bug in the provider:\n  b["c"] is not known; a read returns every value'
    );
  });
});

describe('a schema a provider gives', () => {
  it('is refused where a value inside an object is kept and not computed', () => {
    const nested: Schema = { box: { type: 'object', schema: { lid: { type: 'string', kept: true } } } };

    expect(() => checkSchema('echo', nested)).toThrow('echo keeps box.lid, which it does not compute; only a computed value can be kept, which is a bug in the provider');
  });
});
