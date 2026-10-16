import { Schema, types } from '@clay/contracts';
import { describe, expect, it } from 'vitest';

import { marksOf, schemaRemarked } from '../src/schemaMarks';
import { allSensitive, valueOf, withSensitive } from '../src/Value';

const schema: Schema = {
  token: { type: types.string, computed: true, sensitive: true },
  tags: { type: types.map(types.string), optional: true },
  name: { type: types.string, optional: true, sensitive: false },
};

const text = (data: string) => valueOf(types.string, data);

describe('the marks a schema gives', () => {
  it('marks an attribute the configuration does not give', () => {
    expect(marksOf(schema, {})).toEqual([['token']]);
  });

  it('keeps the parts the configuration marks in an attribute the schema does not', () => {
    const tags = withSensitive(valueOf(types.map(types.string), { a: 'x' }), [['a']]);

    expect(marksOf(schema, { tags, name: allSensitive(text('n')) })).toEqual([['token'], ['tags', 'a'], ['name']]);
  });

  it('drops a part of an attribute the schema marks as a whole', () => {
    const token = withSensitive(valueOf(types.object({}), {}), [['inner']]);

    expect(marksOf(schema, { token })).toEqual([['token']]);
  });

  it('marks as a whole the values of the attributes the schema marks, and no other', () => {
    const marked = schemaRemarked(schema, { token: text('t'), name: text('n') });

    expect(marked.token.sensitive).toEqual([[]]);
    expect(marked.name).not.toHaveProperty('sensitive');
  });
});
