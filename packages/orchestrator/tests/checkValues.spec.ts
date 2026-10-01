import { ExactNumber, Schema, UNKNOWN } from '@clay/contracts';
import { describe, expect, it } from 'vitest';

import { checkValues, SchemaMismatch } from '../src/checkValues';

const schema: Schema = {
  name: { type: 'string' },
  size: { type: 'number' },
  on: { type: 'boolean' },
  ports: { type: 'list', elemType: 'number' },
  tags: { type: 'map', elemType: 'string' },
  anything: { type: 'list' },
  settings: { type: 'object', schema: { mode: { type: 'string', required: true }, depth: { type: 'number' } } },
};

const n = (text: string) => ExactNumber.parse(text);

describe('checkValues', () => {
  it('takes a value of each type the schema names', () => {
    const config = {
      name: 'a',
      size: n('1'),
      on: true,
      ports: [n('80')],
      tags: { a: 'x' },
      anything: ['x', n('1'), [true]],
      settings: { mode: 'm', depth: n('2') },
    };

    expect(() => checkValues('thing', schema, config)).not.toThrow();
  });

  it.each([
    ['a number where it takes a string', { name: n('5') }, 'name is a number, where thing takes a string'],
    ['a string where it takes a number', { size: '5' }, 'size is a string, where thing takes a number'],
    ['a string where it takes a boolean', { on: 'true' }, 'on is a string, where thing takes a boolean'],
    ['a map where it takes a list', { ports: { a: n('1') } }, 'ports is a map, where thing takes a list'],
    ['a list where it takes a map', { tags: ['x'] }, 'tags is a list, where thing takes a map'],
    ['a list where it takes an object', { settings: ['m'] }, 'settings is a list, where thing takes an object'],
    ['an item of a list', { ports: [n('80'), 'http'] }, 'ports[1] is a string, where thing takes a number'],
    ['a value of a map', { tags: { a: 'x', b: true } }, 'tags["b"] is a boolean, where thing takes a string'],
    ['a value inside an object', { settings: { mode: 'm', depth: 'deep' } }, 'settings["depth"] is a string, where thing takes a number'],
    ['a name an object does not have', { settings: { mode: 'm', moed: 'x' } }, 'thing has no attribute "moed" in settings'],
    ['a name an object requires and is not given', { settings: { depth: n('1') } }, 'thing requires "mode" in settings'],
  ])('refuses %s, and names the attribute', (_, config, message) => {
    const attribute = Object.keys(config)[0];

    expect(() => checkValues('thing', schema, config)).toThrow(expect.objectContaining({ message, attribute }));
  });

  it('throws a SchemaMismatch, so the caller can place it at the attribute', () => {
    expect(() => checkValues('thing', schema, { name: true })).toThrow(SchemaMismatch);
  });

  // A saved plan's values reach the apply without the check the load makes.
  it('refuses a name the schema does not have, and names it', () => {
    expect(() => checkValues('thing', schema, { name: 'a', nmae: 'b' })).toThrow(expect.objectContaining({ message: 'thing has no attribute "nmae"', attribute: 'nmae' }));
  });

  it('refuses a name the schema requires and is not given, in no attribute', () => {
    const required: Schema = { path: { type: 'string', required: true } };

    expect(() => checkValues('thing', required, {})).toThrow(expect.objectContaining({ message: 'thing requires "path"', attribute: undefined }));
  });

  // A value the apply makes is checked once it is known, so only what is known now is held to the schema.
  it.each([
    ['a whole value', { name: UNKNOWN, settings: UNKNOWN }],
    ['an item of a list', { ports: [n('80'), UNKNOWN] }],
    ['a value of a map', { tags: { a: UNKNOWN } }],
    ['a value inside an object', { settings: { mode: UNKNOWN } }],
  ])('takes %s not known yet', (_, config) => {
    expect(() => checkValues('thing', schema, config)).not.toThrow();
  });

  it('checks what is known beside what is not', () => {
    expect(() => checkValues('thing', schema, { tags: { a: UNKNOWN, b: n('1') } })).toThrow('tags["b"] is a number, where thing takes a string');
  });

  it('takes any record as an object with no schema of its own', () => {
    expect(() => checkValues('thing', { meta: { type: 'object' } }, { meta: { any: 'x', thing: n('1') } })).not.toThrow();
  });
});
