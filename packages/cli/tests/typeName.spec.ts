import { types } from '@clay/contracts';
import { describe, expect, it } from 'vitest';

import { typeName } from '../src/typeName';

describe('a type as a configuration writes it', () => {
  it.each([
    [types.string, 'string'],
    [types.dynamic, 'dynamic'],
    [types.list(types.set(types.string)), 'list(set(string))'],
    [types.map(types.number), 'map(number)'],
    [types.tuple([types.string, types.bool]), 'tuple([string, bool])'],
    [types.object({ a: types.string, b: types.number }, ['b']), 'object({ a = string, b = optional(number) })'],
    [types.object({}), 'object({})'],
    [types.object({ 'a.b': types.string }), 'object({ "a.b" = string })'],
  ])('spells %j as %s', (type, spelled) => {
    expect(typeName(type)).toBe(spelled);
  });
});
