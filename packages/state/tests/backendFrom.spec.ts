import { BackendBlock, ConfigError, parseModule } from '@clay/parser';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { backendFrom, HttpBackend, LocalBackend } from '../src';

const dir = path.resolve('/workspace');

const blockOf = (body: string, type = 'local') => parseModule([{ file: 'main.clay', content: `clay {\n  backend "${type}" {\n    ${body}\n  }\n}` }])[0] as BackendBlock;

const http = (body: string) => blockOf(body, 'http');

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

    expect(error.message).toBe(`Clay has no backend "${type}"; it has "local", "http"`);
    expect(error.position).toMatchObject({ line: 2, column: 11 });
  });

  describe('of type http', () => {
    const ADDRESSES = 'address = "https://state.example/s"\n    lock_address = "https://state.example/l"';

    it('keeps the state at its address', () => {
      const backend = backendFrom(http(ADDRESSES), dir);

      expect(backend).toBeInstanceOf(HttpBackend);
      expect(backend.location).toBe('https://state.example/s');
    });

    it.each([
      ['address', 'lock_address = "https://state.example/l"'],
      ['lock_address', 'address = "https://state.example/s"'],
    ])('refuses a block with no %s, at its label', (name, body) => {
      const error = errorOf(http(body));

      expect(error.message).toBe(`backend "http" needs "${name}"`);
      expect(error.position).toMatchObject({ line: 2, column: 11 });
    });

    it.each([
      ['a number', 'address = 1', 'address of backend "http" is a string written out'],
      ['nothing', 'address = ""', 'address of backend "http" must not be empty'],
      ['no URL', 'address = "state"', 'address of backend "http" is "state", which is not a URL'],
      ['another scheme', 'address = "ftp://state.example/s"', 'address of backend "http" is "ftp://state.example/s", and only http and https are taken'],
      ['credentials', 'address = "https://me:secret@state.example/s"', 'address of backend "http" holds credentials, which would be printed wherever the address is'],
      ['a user alone', 'address = "https://me@state.example/s"', 'address of backend "http" holds credentials, which would be printed wherever the address is'],
    ])('refuses %s as an address, at the value', (_title, body, message) => {
      const error = errorOf(http(`${body}\n    lock_address = "https://state.example/l"`));

      expect(error.message).toBe(message);
      expect(error.position).toMatchObject({ line: 3, column: 15 });
    });

    it('refuses an unlock address that is no URL, at the value', () => {
      const error = errorOf(http(`${ADDRESSES}\n    unlock_address = "nowhere"`));

      expect(error.message).toBe('unlock_address of backend "http" is "nowhere", which is not a URL');
      expect(error.position).toMatchObject({ line: 5, column: 22 });
    });

    it.each([
      ['a space', 'GE T', 'is "GE T", which is no HTTP method'],
      ['a forbidden one', 'trace', 'is "trace", which a request cannot be sent with'],
    ])('refuses a method with %s, at the value', (_title, method, message) => {
      const error = errorOf(http(`${ADDRESSES}\n    lock_method = "${method}"`));

      expect(error.message).toBe(`lock_method of backend "http" ${message}`);
      expect(error.position).toMatchObject({ line: 5, column: 19 });
    });

    it('refuses an attribute it does not take, naming those it does', () => {
      const error = errorOf(http(`${ADDRESSES}\n    username = "me"`));

      expect(error.message).toBe('backend "http" takes only "address", "update_method", "lock_address", "lock_method", "unlock_address", "unlock_method", not "username"');
      expect(error.position).toMatchObject({ line: 5, column: 16 });
    });
  });
});
