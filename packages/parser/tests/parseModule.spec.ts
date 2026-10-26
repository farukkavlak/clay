import { describe, expect, it } from 'vitest';

import { ConfigError } from '../src/ConfigError';
import { parseModule } from '../src/Parser';

function errorOf(files: { file: string; content: string }[]): ConfigError {
  try {
    parseModule(files);
  } catch (error) {
    if (error instanceof ConfigError) return error;

    throw error;
  }

  throw new Error('Expected the module to be refused');
}

describe('parseModule', () => {
  it('reads the blocks of every file, in the order the files are given', () => {
    const program = parseModule([
      { file: 'a.clay', content: 'resource "null_resource" "x" {}' },
      { file: 'b.clay', content: 'variable "v" { default = 1 }\nresource "null_resource" "y" {}' },
    ]);

    expect(program.map((statement) => `${statement.type} ${'name' in statement ? statement.name : ''}`)).toEqual(['Resource x', 'Variable v', 'Resource y']);
  });

  it('refuses a block declared in two files, at the second, naming where the first is', () => {
    const error = errorOf([
      { file: 'a.clay', content: '\nresource "null_resource" "x" {}' },
      { file: 'b.clay', content: 'resource "null_resource" "x" {}' },
    ]);

    expect(error.message).toBe('resource "null_resource" "x" is declared twice, first on a.clay line 2');
    expect(error.position).toEqual({ file: 'b.clay', line: 1, column: 1 });
  });

  it('refuses a local set in two files', () => {
    const error = errorOf([
      { file: 'a.clay', content: 'locals { l = 1 }' },
      { file: 'b.clay', content: 'locals { l = 2 }' },
    ]);

    expect(error.message).toBe('local "l" is declared twice, first on a.clay line 1');
    expect(error.position).toEqual({ file: 'b.clay', line: 1, column: 10 });
  });

  it.each([
    ['the for is in the first', 'output "o" { value = [for local_file in ["a"] : local_file] }', 'resource "local_file" "f" {}', 'a.clay'],
    ['the resource is in the first', 'resource "local_file" "f" {}', 'output "o" { value = [for local_file in ["a"] : local_file] }', 'b.clay'],
  ])('refuses a for name that is the type of a resource in another file, when %s', (_, first, second, file) => {
    const error = errorOf([
      { file: 'a.clay', content: first },
      { file: 'b.clay', content: second },
    ]);

    expect(error.message).toBe('"local_file" cannot name an item in a for: a reference reads "local_file." as a resource of that type');
    expect(error.position).toEqual({ file, line: 1, column: 27 });
  });
});
