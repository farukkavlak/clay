import { BackendBlock, ConfigError, parseModule } from '@clay/parser';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { backendFrom, LocalBackend } from '../src';

const dir = path.resolve('/workspace');

const blockOf = (body: string, type = 'local') => parseModule([{ file: 'main.clay', content: `clay {\n  backend "${type}" {\n    ${body}\n  }\n}` }])[0] as BackendBlock;

const errorOf = (block: BackendBlock): ConfigError => {
  try {
    backendFrom(block, dir);
  } catch (error) {
    if (error instanceof ConfigError) return error;

    throw error;
  }

  throw new Error('Expected the block to be refused');
};

describe('backendFrom', () => {
  it('keeps the state next to the configuration where no block names a place', () => {
    const backend = backendFrom(undefined, dir);

    expect(backend).toBeInstanceOf(LocalBackend);
    expect(backend.location).toBe(path.join(dir, 'clay.state.json'));
  });

  it('keeps it there where the block names none', () => {
    expect(backendFrom(blockOf(''), dir).location).toBe(path.join(dir, 'clay.state.json'));
  });

  it('reads a path from the working directory', () => {
    expect(backendFrom(blockOf('path = "deep/s.json"'), dir).location).toBe(path.join(dir, 'deep', 's.json'));
  });

  it('reads a path out of the working directory', () => {
    expect(backendFrom(blockOf('path = "../s.json"'), dir).location).toBe(path.join(path.dirname(dir), 's.json'));
  });

  it('takes an absolute path as it is', () => {
    const elsewhere = path.resolve('/elsewhere/s.json');

    expect(backendFrom(blockOf(`path = "${elsewhere}"`), dir).location).toBe(elsewhere);
  });

  it.each([
    ['a number', 'path = 1', 'path of backend "local" is a string written out'],
    ['a template', 'path = "${1}"', 'path of backend "local" is a string written out'],
    ['nothing', 'path = ""', 'path of backend "local" must not be empty'],
    ['a configuration file', 'path = "main.clay"', 'path of backend "local" is "main.clay", and a file ending in .clay is configuration'],
    ['one in another case', 'path = "MAIN.Clay"', 'path of backend "local" is "MAIN.Clay", and a file ending in .clay is configuration'],
  ])('refuses %s as a path, at the value', (_title, body, message) => {
    const error = errorOf(blockOf(body));

    expect(error.message).toBe(message);
    expect(error.position).toMatchObject({ line: 3, column: 12 });
  });

  it('refuses an attribute the backend does not take, at its value', () => {
    const error = errorOf(blockOf('bucket = "b"'));

    expect(error.message).toBe('backend "local" takes only "path", not "bucket"');
    expect(error.position).toMatchObject({ line: 3, column: 14 });
  });

  it.each(['s3', 'toString'])('refuses the type %s at its label', (type) => {
    const error = errorOf(blockOf('', type));

    expect(error.message).toBe(`Clay has no backend "${type}"; it has "local"`);
    expect(error.position).toMatchObject({ line: 2, column: 11 });
  });
});
