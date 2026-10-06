import { ExactNumber, types, UNKNOWN } from '@clay/contracts';
import { ConfigError } from '@clay/parser';
import { describe, expect, it } from 'vitest';

import { readPath } from '../../src/resolvers/readPath';
import { UnresolvedReferenceError } from '../../src/resolvers/UnresolvedReferenceError';
import { inferred, Value, valueOf } from '../../src/Value';
import { steps } from '../ast';

const at = { file: 'main.clay', line: 2, column: 9 };

/** As the configuration writes it: a list is a tuple and a map an object. */
const written = (data: unknown): Value => valueOf(inferred(data), data);

const errorOf = (value: Value, path: (string | number)[]): ConfigError => {
  try {
    readPath(value, 'var.tags', steps(...path), at);
  } catch (error) {
    if (error instanceof ConfigError) return error;

    throw error;
  }

  throw new Error(`Expected an error from: ${path.join('.')}`);
};

const tags = { env: 'prod', owners: ['ana', 'bo'], nested: { deep: { name: 'x' } } };

describe('reading a path into a value', () => {
  it.each([
    [['env'], 'prod'],
    [['owners', 1], 'bo'],
    [['nested', 'deep', 'name'], 'x'],
    [[], tags],
  ])('reads %j', (path, expected) => {
    expect(readPath(written(tags), 'var.tags', steps(...path), at).data).toEqual(expected);
  });

  it('reads a key named like something every object has, when the map holds it', () => {
    expect(readPath(written(JSON.parse('{"__proto__": "own"}')), 'var.m', steps('__proto__'), at).data).toBe('own');
  });

  // The element type comes from the collection, so a set inside a list stays a set.
  it('reads an item with the type its place names', () => {
    const groups = valueOf(types.list(types.set(types.string)), [['a']]);

    expect(readPath(groups, 'var.g', steps(0), at)).toEqual(valueOf(types.set(types.string), ['a']));
  });

  it('reads an item of a dynamic list with the type its data has', () => {
    expect(readPath(valueOf(types.list(types.dynamic), [['a']]), 'var.g', steps(0), at).type).toEqual(types.tuple([types.string]));
  });

  it.each([
    ['a key the object does not have', written(tags), ['ennv'], 'var.tags has no key "ennv"'],
    ['a name every object answers to', written(tags), ['toString'], 'var.tags has no key "toString"'],
    ['a key under a step that worked', written(tags), ['nested', 'deep', 'nam'], 'var.tags.nested.deep has no key "nam"'],
    ['an index past the end', written(tags), ['owners', 2], 'var.tags.owners has no item [2]: it holds 2'],
    ['an index into an empty list', valueOf(types.list(types.string), []), [0], 'var.tags has no item [0]: it holds 0'],
    ['a key on a tuple', written(tags), ['owners', 'first'], 'var.tags.owners is a tuple and has no key "first"'],
    ['a key on a list', valueOf(types.list(types.string), ['a']), ['first'], 'var.tags is a list and has no key "first"'],
    ['an index on an object', written(tags), [0], 'var.tags is an object and has no item [0]'],
    ['an index on a map', valueOf(types.map(types.string), { a: 'x' }), [0], 'var.tags is a map and has no item [0]'],
    ['an index into a set', valueOf(types.set(types.string), ['a']), [0], 'var.tags is a set and has no item [0]: its members have no order'],
    ['a key into a set', valueOf(types.set(types.string), ['a']), ['a'], 'var.tags is a set and has no key "a"'],
    ['a step into a string', written(tags), ['env', 'x'], 'var.tags.env is a string and cannot be read into'],
    ['a step into a number', written({ n: ExactNumber.parse('3') }), ['n', 0], 'var.tags.n is a number and cannot be read into'],
    ['a step into a boolean', written({ b: true }), ['b', 'x'], 'var.tags.b is a boolean and cannot be read into'],
    ['a step into null', written({ z: null }), ['z', 'x'], 'var.tags.z is null and cannot be read into'],
    ['a step into null of a type that is read into', valueOf(types.map(types.string), null), ['x'], 'var.tags is null and cannot be read into'],
  ])('refuses %s, naming what it read, where the reference is written', (_, value, path, message) => {
    const error = errorOf(value, path);

    expect(error.message).toBe(message);
    expect(error.position).toEqual(at);
  });

  // The reader can check its type before apply knows the value.
  it('reads a value not known yet as nothing yet, with the type it will have', () => {
    const read = () => readPath(valueOf(types.object({ id: types.string }), { id: UNKNOWN }), 'a.b', steps('id'), at);

    expect(read).toThrow(UnresolvedReferenceError);
    expect(read).toThrow(expect.objectContaining({ message: 'a.b.id is known only after apply', type: types.string }));
  });

  // The map is unknown, and the steps into it reach a string.
  it('reads into a value not known yet as the type the steps into it will find', () => {
    const tags = types.object({ tags: types.map(types.list(types.string)) });
    const read = () => readPath(valueOf(tags, { tags: UNKNOWN }), 'a.b', steps('tags', 'x', 0), at);

    expect(read).toThrow(expect.objectContaining({ message: 'a.b.tags is known only after apply', type: types.string }));
  });
});
