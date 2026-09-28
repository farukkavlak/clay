import { describe, expect, it } from 'vitest';

import { CONFIG_FILE } from '../src/ast';
import { ConfigError } from '../src/ConfigError';
import { parseReference, spellReference, Step } from '../src/reference';

const position = { file: CONFIG_FILE, line: 1, column: 1 };

const parse = (spelled: string) => parseReference(spelled.split('.'), position);

const errorOf = (parts: Step[]): ConfigError => {
  try {
    parseReference(parts, position);
  } catch (error) {
    if (error instanceof ConfigError) return error;

    throw error;
  }

  throw new Error(`Expected an error from: ${parts.join('.')}`);
};

describe('a reference read into a value', () => {
  it.each([
    ['var.text', { kind: 'variable', name: 'text', path: [] }],
    ['data.local_file.f.content', { kind: 'data', type: 'local_file', name: 'f', attribute: 'content', path: [] }],
    ['module.app.url', { kind: 'module', module: 'app', output: 'url', path: [] }],
    ['local_file.a.content', { kind: 'resource', type: 'local_file', name: 'a', path: ['content'] }],
    ['count.index', { kind: 'count', path: [] }],
    ['each.key', { kind: 'each', name: 'key', path: [] }],
    ['each.value.port', { kind: 'each', name: 'value', path: ['port'] }],
    ['var.tags.env', { kind: 'variable', name: 'tags', path: ['env'] }],
    ['data.local_file.f.tags.env', { kind: 'data', type: 'local_file', name: 'f', attribute: 'tags', path: ['env'] }],
    ['module.app.tags.env', { kind: 'module', module: 'app', output: 'tags', path: ['env'] }],
    ['local_file.a.tags.env.name', { kind: 'resource', type: 'local_file', name: 'a', path: ['tags', 'env', 'name'] }],
  ])('reads %s as what it names, what it reads on it, and the steps into that value', (spelled, expected) => {
    expect(parse(spelled)).toEqual(expected);
  });

  // Whether a resource's first step is an instance key or an attribute depends on its block, which only the engine knows.
  it('reads what follows a resource name as steps, an index and all', () => {
    expect(parseReference(['local_file', 'a', 0, 'content'], position)).toEqual({ kind: 'resource', type: 'local_file', name: 'a', path: [0, 'content'] });
    expect(parseReference(['local_file', 'a', 'tags.env'], position)).toEqual({ kind: 'resource', type: 'local_file', name: 'a', path: ['tags.env'] });
  });

  it('reads an index as a step into the value', () => {
    expect(parseReference(['var', 'names', 0, 'first'], position)).toEqual({ kind: 'variable', name: 'names', path: [0, 'first'] });
  });

  // A key is any text; only a part that names the target has to be a name.
  it('reads a key that is no name as a step', () => {
    expect(parseReference(['var', 'tags', ''], position)).toEqual({ kind: 'variable', name: 'tags', path: [''] });
    expect(parseReference(['module', 'app', 'url', 'a.b'], position)).toEqual({ kind: 'module', module: 'app', output: 'url', path: ['a.b'] });
  });

  // The engine resolves values long after the file is read, and adds the place itself.
  it('refuses a reference with a plain error when it is given no position', () => {
    expect(() => parseReference(['local_file', 'a'])).toThrow('Resource reference must include attribute: local_file.a');
    expect(() => parseReference(['local_file', 'a'])).not.toThrow(ConfigError);
  });

  it.each([
    [['var'], 'Variable reference must include a name: var'],
    [['data', 'local_file', 'f'], 'Data source reference must include attribute: data.local_file.f'],
    [['module', 'app'], 'Module output reference must include output name: module.app'],
    [['local_file', 'a'], 'Resource reference must include attribute: local_file.a'],
    [['local_file', '', 'id'], 'Reference "local_file[""].id" has "" where it needs a name'],
    [['var', '', 'name'], 'Reference "var[""].name" has "" where it needs a name'],
    [['var', 'a b'], 'Reference "var["a b"]" has "a b" where it needs a name'],
    [['module', 'a.module.b', 'secret'], 'Reference "module["a.module.b"].secret" has "a.module.b" where it needs a name'],
    [['data', 'module.m.local_file', 'd', 'content'], 'Reference "data["module.m.local_file"].d.content" has "module.m.local_file" where it needs a name'],
    [['local_file', 'x.y', 'id'], 'Reference "local_file["x.y"].id" has "x.y" where it needs a name'],
    [['var', 0], 'Reference "var[0]" has an index where it needs a name'],
    [['data', 'local_file', 0, 'content'], 'Reference "data.local_file[0].content" has an index where it needs a name'],
    [['module', 'app', 0], 'Reference "module.app[0]" has an index where it needs a name'],
    [['count'], 'Reference "count" names nothing: count.index is the index of an instance'],
    [['count', 'id'], 'Reference "count.id" names nothing: count.index is the index of an instance'],
    [['count', 0], 'Reference "count[0]" has an index where it needs a name'],
    [['each'], 'Reference "each" names nothing: each.key and each.value are the key and value of an instance'],
    [['each', 'index'], 'Reference "each.index" names nothing: each.key and each.value are the key and value of an instance'],
    [['each', 0], 'Reference "each[0]" has an index where it needs a name'],
    [[0, 'a', 'id'], 'Reference "[0].a.id" has an index where it needs a name'],
  ])('refuses %j', (parts, message) => {
    const error = errorOf(parts);

    expect(error.message).toContain(message);
    expect(error.position).toEqual(position);
  });
});

describe('a reference spelled back', () => {
  it.each([
    [['var', 'names', 0], 'var.names[0]'],
    [['local_file', 'a', 'tags', 'env'], 'local_file.a.tags.env'],
    [['var', 'tags', 'a.b', 1], 'var.tags["a.b"][1]'],
    [['var', 'tags', 'say "hi"'], String.raw`var.tags["say \"hi\""]`],
    [['var', 'tags', ''], 'var.tags[""]'],
  ])('spells %j as %s', (parts, spelled) => {
    expect(spellReference(parts)).toBe(spelled);
  });
});
