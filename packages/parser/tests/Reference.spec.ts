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
    ['var.text', { kind: 'variable', name: 'text' }],
    ['data.local_file.f.content', { kind: 'data', type: 'local_file', name: 'f', attribute: 'content' }],
    ['module.app.url', { kind: 'module', module: 'app', output: 'url' }],
    ['local_file.a.content', { kind: 'resource', type: 'local_file', name: 'a', attribute: 'content' }],
  ])('reads %s as what it names and what it reads on it', (spelled, expected) => {
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
    ['local_file..id', 'Reference "local_file..id" has a part that is empty'],
    ['var..name', 'Reference "var..name" has a part that is empty'],
    ['var.text.deeper', 'Reference "var.text.deeper" reads deeper than the variable "text"'],
    ['local_file.a.tags.env', 'Reference "local_file.a.tags.env" reads deeper than the attribute "tags"'],
    ['data.local_file.f.tags.env', 'Reference "data.local_file.f.tags.env" reads deeper than the attribute "tags"'],
  ])('refuses %s', (spelled, message) => {
    const error = errorOf(spelled);

    expect(error.message).toContain(message);
    expect(error.position).toEqual(position);
  });
});
