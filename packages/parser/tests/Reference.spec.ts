import { describe, expect, it } from 'vitest';

import { CONFIG_FILE } from '../src/ast';
import { ConfigError } from '../src/ConfigError';
import { parseReference, spellReference, Step } from '../src/reference';
import { steps } from './steps';

const position = { file: CONFIG_FILE, line: 1, column: 1 };

const parse = (spelled: string) => parseReference(steps(...spelled.split('.')), position);

const errorOf = (parts: Step[]): ConfigError => {
  try {
    parseReference(parts, position);
  } catch (error) {
    if (error instanceof ConfigError) return error;

    throw error;
  }

  throw new Error(`Expected an error from: ${spellReference(parts)}`);
};

describe('a reference read into a value', () => {
  it.each([
    ['var.text', { kind: 'variable', name: 'text', path: steps() }],
    ['data.local_file.f', { kind: 'data', type: 'local_file', name: 'f', path: steps() }],
    ['data.local_file.f.content', { kind: 'data', type: 'local_file', name: 'f', path: steps('content') }],
    ['module.app.url', { kind: 'module', module: 'app', path: steps('url') }],
    ['module.app', { kind: 'module', module: 'app', path: steps() }],
    ['local_file.a.content', { kind: 'resource', type: 'local_file', name: 'a', path: steps('content') }],
    ['local_file.a', { kind: 'resource', type: 'local_file', name: 'a', path: steps() }],
    ['count.index', { kind: 'count', path: steps() }],
    ['each.key', { kind: 'each', name: 'key', path: steps() }],
    ['each.value.port', { kind: 'each', name: 'value', path: steps('port') }],
    ['path.module', { kind: 'path', name: 'module', path: steps() }],
    ['path.root', { kind: 'path', name: 'root', path: steps() }],
    ['var.tags.env', { kind: 'variable', name: 'tags', path: steps('env') }],
    ['local.name', { kind: 'local', name: 'name', path: steps() }],
    ['local.tags.env', { kind: 'local', name: 'tags', path: steps('env') }],
    ['data.local_file.f.tags.env', { kind: 'data', type: 'local_file', name: 'f', path: steps('tags', 'env') }],
    ['module.app.tags.env', { kind: 'module', module: 'app', path: steps('tags', 'env') }],
    ['local_file.a.tags.env.name', { kind: 'resource', type: 'local_file', name: 'a', path: steps('tags', 'env', 'name') }],
  ])('reads %s as what it names, what it reads on it, and the steps into that value', (spelled, expected) => {
    expect(parse(spelled)).toEqual(expected);
  });

  // Whether the first step is an instance key depends on the block, which only the engine knows.
  it('reads what follows a resource name as steps, an index and all', () => {
    expect(parseReference(steps('local_file', 'a', 0, 'content'), position)).toEqual({ kind: 'resource', type: 'local_file', name: 'a', path: steps(0, 'content') });
    expect(parseReference(steps('local_file', 'a', { key: 'tags.env' }), position)).toEqual({ kind: 'resource', type: 'local_file', name: 'a', path: steps({ key: 'tags.env' }) });
  });

  // Whether the first step is an instance key depends on the module call, which only the engine knows.
  it('reads what follows a module name as steps, an index and all', () => {
    expect(parseReference(steps('module', 'app', 0, 'url'), position)).toEqual({ kind: 'module', module: 'app', path: steps(0, 'url') });
  });

  it('reads an index as a step into the value', () => {
    expect(parseReference(steps('var', 'names', 0, 'first'), position)).toEqual({ kind: 'variable', name: 'names', path: steps(0, 'first') });
  });

  // A key is any text; only the target's parts must be names.
  it('reads a key that is no name as a step', () => {
    expect(parseReference(steps('var', 'tags', { key: '' }), position)).toEqual({ kind: 'variable', name: 'tags', path: steps({ key: '' }) });
    expect(parseReference(steps('module', 'app', 'url', { key: 'a.b' }), position)).toEqual({ kind: 'module', module: 'app', path: steps('url', { key: 'a.b' }) });
  });

  // The engine resolves values later and adds the position itself.
  it('refuses a reference with a plain error when it is given no position', () => {
    expect(() => parseReference(steps('local_file'))).toThrow('Reference "local_file" names nothing: a resource is read as its type and its name, as in local_file.a');
    expect(() => parseReference(steps('local_file'))).not.toThrow(ConfigError);
  });

  it.each([
    [steps(), 'Reference "" names nothing: a resource is read as its type and its name, as in local_file.a'],
    [steps('var'), 'Variable reference must include a name: var'],
    [steps('data', 'local_file'), 'Reference "data.local_file" names nothing: a data source is read as data, its type and its name, as in data.local_file.a'],
    [steps('local'), 'Reference "local" names nothing: a local is read by its name, as in local.name'],
    [steps('local', 0), 'Reference "local[0]" has an index where it needs a name'],
    [steps('module'), 'Reference "module" names nothing: a module is read by its name, as in module.web'],
    [steps('local_file'), 'Reference "local_file" names nothing: a resource is read as its type and its name, as in local_file.a'],
    [steps('local_file', { key: '' }, 'id'), 'Reference "local_file[""].id" has "" where it needs a name'],
    [steps('var', { key: '' }, 'name'), 'Reference "var[""].name" has "" where it needs a name'],
    [steps('var', { key: 'a b' }), 'Reference "var["a b"]" has "a b" where it needs a name'],
    [steps('module', { key: 'a.module.b' }, 'secret'), 'Reference "module["a.module.b"].secret" has "a.module.b" where it needs a name'],
    [steps('data', { key: 'module.m.local_file' }, 'd', 'content'), 'Reference "data["module.m.local_file"].d.content" has "module.m.local_file" where it needs a name'],
    [steps('local_file', { key: 'x.y' }, 'id'), 'Reference "local_file["x.y"].id" has "x.y" where it needs a name'],
    [steps('var', 0), 'Reference "var[0]" has an index where it needs a name'],
    [steps('data', 'local_file', 0, 'content'), 'Reference "data.local_file[0].content" has an index where it needs a name'],
    [steps('count'), 'Reference "count" names nothing: count.index is the index of an instance'],
    [steps('count', 'id'), 'Reference "count.id" names nothing: count.index is the index of an instance'],
    [steps('count', 0), 'Reference "count[0]" has an index where it needs a name'],
    [steps('each'), 'Reference "each" names nothing: each.key and each.value are the key and value of an instance'],
    [steps('each', 'index'), 'Reference "each.index" names nothing: each.key and each.value are the key and value of an instance'],
    [steps('each', 0), 'Reference "each[0]" has an index where it needs a name'],
    [steps('path'), 'Reference "path" names nothing: path.module and path.root are the directories of a module and of the root'],
    [steps('path', 'cwd'), 'Reference "path.cwd" names nothing: path.module and path.root are the directories of a module and of the root'],
    [steps('path', 0), 'Reference "path[0]" has an index where it needs a name'],
    [steps(0, 'a', 'id'), 'Reference "[0].a.id" has an index where it needs a name'],
  ])('refuses %j', (parts, message) => {
    const error = errorOf(parts);

    expect(error.message).toContain(message);
    expect(error.position).toEqual(position);
  });
});

describe('a reference spelled back', () => {
  it.each([
    [steps('var', 'names', 0), 'var.names[0]'],
    [steps('local_file', 'a', 'tags', 'env'), 'local_file.a.tags.env'],
    [steps('var', 'tags', { key: 'a.b' }, 1), 'var.tags["a.b"][1]'],
    [steps('var', 'tags', { key: 'env' }), 'var.tags["env"]'],
    [steps('var', 'tags', { key: 'say "hi"' }), String.raw`var.tags["say \"hi\""]`],
    [steps('var', 'tags', { key: '' }), 'var.tags[""]'],
  ])('spells %j as %s', (parts, spelled) => {
    expect(spellReference(parts)).toBe(spelled);
  });
});
