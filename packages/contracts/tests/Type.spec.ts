import { describe, expect, it } from 'vitest';

import { Schema, typeAt, typeIn, types } from '../src';

describe('the type one step into a type finds', () => {
  const settings = types.object({ mode: types.string });

  it.each([
    ['an element of a list', types.list(types.number), 0, types.number],
    ['a member of a set', types.set(types.bool), 0, types.bool],
    ['a value of a map', types.map(types.string), 'a', types.string],
    ['an item of a tuple', types.tuple([types.string, types.number]), 1, types.number],
    ['an attribute of an object', settings, 'mode', types.string],
  ])('is %s', (_, type, step, found) => {
    expect(typeAt(type, step)).toEqual(found);
  });

  // Plain indexing would find inherited names like `toString`.
  it.each([
    ['an item past the end of a tuple', types.tuple([types.string]), 1],
    ['a name an object does not have', settings, 'depth'],
    ['a name every object inherits', settings, 'toString'],
    ['a step into a string', types.string, 'a'],
  ])('is dynamic for %s', (_, type, step) => {
    expect(typeAt(type, step)).toEqual(types.dynamic);
  });
});

describe('the type a schema names', () => {
  const schema: Schema = { ports: { type: types.list(types.number) } };

  it('is the one it gives the name', () => {
    expect(typeIn(schema, 'ports')).toEqual(types.list(types.number));
  });

  it('is dynamic for a name it does not have', () => {
    expect(typeIn(schema, 'size')).toEqual(types.dynamic);
  });
});
