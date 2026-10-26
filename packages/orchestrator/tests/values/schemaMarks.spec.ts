import { EVERY_ITEM, MAYBE, Schema, types, UNKNOWN } from '@clay/contracts';
import { describe, expect, it } from 'vitest';

import { marksOf, schemaRemarked } from '../../src/values/schemaMarks';
import { allSensitive, valueOf, withSensitive } from '../../src/values/Value';

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
    const marked = schemaRemarked(schema, { token: text('t'), name: text('n') }, {});

    expect(marked.token.sensitive).toEqual([[]]);
    expect(marked.name).not.toHaveProperty('sensitive');
  });
});

describe('an attribute the schema marks sensitive with others', () => {
  const echoing: Schema = {
    command: { type: types.string, required: true },
    cwd: { type: types.string, optional: true },
    stdout: { type: types.string, computed: true, sensitiveWith: ['command', 'cwd'] },
  };

  it('is sensitive as a whole where one of them holds a sensitive part', () => {
    const command = withSensitive(valueOf(types.string, 'echo s'), [[]]);

    expect(marksOf(echoing, { command })).toEqual([['stdout'], ['command']]);
    expect(schemaRemarked(echoing, { stdout: text('s') }, { cwd: allSensitive(text('/s')) }).stdout.sensitive).toEqual([[]]);
  });

  it('is not sensitive where none of them is', () => {
    expect(marksOf(echoing, { command: text('echo hi') })).toEqual([]);
    expect(schemaRemarked(echoing, { stdout: text('hi') }, { command: text('echo hi') }).stdout).not.toHaveProperty('sensitive');
  });

  it('may be sensitive as a whole where one of them only may be sensitive', () => {
    const command = withSensitive(valueOf(types.string, 'echo s'), [[MAYBE]]);

    expect(marksOf(echoing, { command })).toEqual([
      ['stdout', MAYBE],
      ['command', MAYBE],
    ]);
    expect(schemaRemarked(echoing, { stdout: text('s') }, { command }).stdout.sensitive).toEqual([[MAYBE]]);
  });

  it('is sensitive as a whole where one of them is, though another only may be', () => {
    const command = withSensitive(valueOf(types.string, 'echo s'), [[MAYBE]]);

    expect(marksOf(echoing, { command, cwd: allSensitive(text('/s')) })).toEqual([['stdout'], ['command', MAYBE], ['cwd']]);
  });
});

describe('an attribute the schema marks sensitive with a list', () => {
  const joining: Schema = {
    parts: { type: types.list(types.string), required: true },
    joined: { type: types.string, computed: true, sensitiveWith: ['parts'] },
  };
  const everyItem = (data: unknown) => withSensitive(valueOf(types.list(types.string), data), [[EVERY_ITEM]]);

  it('may be sensitive where every item of a list not known yet is, since it may come out empty', () => {
    expect(marksOf(joining, { parts: everyItem(UNKNOWN) })).toEqual([
      ['joined', MAYBE],
      ['parts', EVERY_ITEM],
    ]);
  });

  it('is sensitive where every item of a list that holds one is', () => {
    expect(marksOf(joining, { parts: everyItem(['a']) })).toEqual([['joined'], ['parts', EVERY_ITEM]]);
  });
});
