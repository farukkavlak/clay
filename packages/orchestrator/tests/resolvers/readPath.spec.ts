import { ExactNumber } from '@clay/contracts';
import { ConfigError } from '@clay/parser';
import { UNKNOWN } from '@clay/planner';
import { describe, expect, it } from 'vitest';

import { kindOf, readPath } from '../../src/resolvers/readPath';

const at = { file: 'main.clay', line: 2, column: 9 };
const errorOf = (value: unknown, path: (string | number)[]): ConfigError => {
  try {
    readPath(value, ['var', 'tags'], path, at);
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
    expect(readPath(tags, ['var', 'tags'], path, at)).toEqual(expected);
  });

  it('reads a key named like something every object has, when the map holds it', () => {
    expect(readPath(JSON.parse('{"__proto__": "own"}'), ['var', 'm'], ['__proto__'], at)).toBe('own');
  });

  it.each([
    ['a key the map does not have', tags, ['ennv'], 'var.tags has no key "ennv"'],
    ['a name every object answers to', tags, ['toString'], 'var.tags has no key "toString"'],
    ['a key under a step that worked', tags, ['nested', 'deep', 'nam'], 'var.tags.nested.deep has no key "nam"'],
    ['an index past the end', tags, ['owners', 2], 'var.tags.owners has no item [2]: it holds 2'],
    ['an index into an empty list', [], [0], 'var.tags has no item [0]: it holds 0'],
    ['a key on a list', tags, ['owners', 'first'], 'var.tags.owners is a list and has no key "first"'],
    ['an index on a map', tags, [0], 'var.tags is a map and has no item [0]'],
    ['a step into a string', tags, ['env', 'x'], 'var.tags.env is a string and cannot be read into'],
    ['a step into a number', { n: ExactNumber.parse('3') }, ['n', 0], 'var.tags.n is a number and cannot be read into'],
    ['a step into a boolean', { b: true }, ['b', 'x'], 'var.tags.b is a bool and cannot be read into'],
    ['a step into null', { z: null }, ['z', 'x'], 'var.tags.z is null and cannot be read into'],
  ])('refuses %s, naming what it read, where the reference is written', (_, value, path, message) => {
    const error = errorOf(value, path);

    expect(error.message).toBe(message);
    expect(error.position).toEqual(at);
  });
});

describe('the kind of a value', () => {
  it.each([
    ['a list', ['a'], 'list'],
    ['a number', ExactNumber.parse('1'), 'number'],
    ['null', null, 'null'],
    ['a map', { a: 'x' }, 'map'],
    ['a bool', true, 'bool'],
    ['a string', 'x', 'string'],
    // Without its own check, a symbol would be named a string.
    ['a value only an apply makes', UNKNOWN, 'value known only after apply'],
  ])('names %s', (_, value, kind) => {
    expect(kindOf(value)).toBe(kind);
  });
});
