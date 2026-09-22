import { describe, expect, it } from 'vitest';

import { CONFIG_FILE } from '../src/ast';
import { ConfigError } from '../src/ConfigError';
import { parseReference } from '../src/reference';

const position = { file: CONFIG_FILE, line: 1, column: 1 };

const parse = (spelled: string) => parseReference(spelled.split('.'), position);

const errorOf = (spelled: string): ConfigError => {
  try {
    parse(spelled);
  } catch (error) {
    if (error instanceof ConfigError) return error;

    throw error;
  }

  throw new Error(`Expected an error from: ${spelled}`);
};

describe('a reference read into a value', () => {
  it.each([
    ['var.text', { kind: 'variable', name: 'text', path: [] }],
    ['data.local_file.f.content', { kind: 'data', type: 'local_file', name: 'f', path: ['content'] }],
    ['module.app.url', { kind: 'module', module: 'app', output: 'url' }],
    ['local_file.a.content', { kind: 'resource', type: 'local_file', name: 'a', path: ['content'] }],
    ['local_file.a.tags.env', { kind: 'resource', type: 'local_file', name: 'a', path: ['tags', 'env'] }],
    ['var.list.0', { kind: 'variable', name: 'list', path: ['0'] }],
  ])('reads %s as what it names and the path on it', (spelled, expected) => {
    expect(parse(spelled)).toEqual(expected);
  });

  // The engine resolves values long after the file is read, and adds the place itself.
  it('refuses a reference with a plain error when it is given no position', () => {
    expect(() => parseReference(['local_file', 'a'])).toThrow('Resource reference must include attribute: local_file.a');
    expect(() => parseReference(['local_file', 'a'])).not.toThrow(ConfigError);
  });

  it.each([
    ['var', 'Variable reference must include a name: var'],
    ['data.local_file.f', 'Data source reference must include attribute: data.local_file.f'],
    ['module.app', 'Module output reference must include output name: module.app'],
    ['module.app.local_file.a', 'reaches into a module'],
    ['local_file.a', 'Resource reference must include attribute: local_file.a'],
  ])('refuses %s', (spelled, message) => {
    const error = errorOf(spelled);

    expect(error.message).toContain(message);
    expect(error.position).toEqual(position);
  });
});
