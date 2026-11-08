import { BackendBlock, ConfigError, parseModule } from '@clay/parser';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { backendFrom, HttpBackend, LocalBackend } from '../src';
import { Environment } from '../src/backends/settings';
import { S3Backend } from '../src/backends/S3Backend';

const dir = path.resolve('/workspace');

const blockOf = (body: string, type = 'local') => parseModule([{ file: 'main.clay', content: `clay {\n  backend "${type}" {\n    ${body}\n  }\n}` }])[0] as BackendBlock;

const http = (body: string) => blockOf(body, 'http');

const s3 = (body: string) => blockOf(body, 's3');

const choiceOf = (body: string, env: Environment = {}) => (backendFrom(s3(body), dir, env) as S3Backend).choice;

const errorOf = (block: BackendBlock, env: Environment = {}): ConfigError => {
  try {
    backendFrom(block, dir, env);
  } catch (error) {
    if (error instanceof ConfigError) return error;

    throw error;
  }

  throw new Error('Expected the block to be refused');
};

describe('backendFrom', () => {
  it('keeps the state next to the configuration where no block names a place', () => {
    const backend = backendFrom(undefined, dir, {});

    expect(backend).toBeInstanceOf(LocalBackend);
    expect(backend.location).toBe(path.join(dir, 'clay.state.json'));
  });

  it('keeps it there where the block names none', () => {
    expect(backendFrom(blockOf(''), dir, {}).location).toBe(path.join(dir, 'clay.state.json'));
  });

  it('reads a path from the working directory', () => {
    expect(backendFrom(blockOf('path = "deep/s.json"'), dir, {}).location).toBe(path.join(dir, 'deep', 's.json'));
  });

  it('reads a path out of the working directory', () => {
    expect(backendFrom(blockOf('path = "../s.json"'), dir, {}).location).toBe(path.join(path.dirname(dir), 's.json'));
  });

  it('takes an absolute path as it is', () => {
    const elsewhere = path.resolve('/elsewhere/s.json');

    expect(backendFrom(blockOf(`path = "${elsewhere}"`), dir, {}).location).toBe(elsewhere);
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

  it.each(['gcs', 'toString'])('refuses the type %s at its label', (type) => {
    const error = errorOf(blockOf('', type));

    expect(error.message).toBe(`Clay has no backend "${type}"; it has "local", "http", "s3"`);
    expect(error.position).toMatchObject({ line: 2, column: 11 });
  });

  describe('of type http', () => {
    const ADDRESSES = 'address = "https://state.example/s"\n    lock_address = "https://state.example/l"';

    it('keeps the state at its address', () => {
      const backend = backendFrom(http(ADDRESSES), dir, {});

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
      ['a forbidden one', 'trace', 'is "trace", which opens a tunnel or echoes the request, and keeps no state'],
    ])('refuses a method with %s, at the value', (_title, method, message) => {
      const error = errorOf(http(`${ADDRESSES}\n    lock_method = "${method}"`));

      expect(error.message).toBe(`lock_method of backend "http" ${message}`);
      expect(error.position).toMatchObject({ line: 5, column: 19 });
    });

    it('refuses an attribute it does not take, naming those it does', () => {
      const error = errorOf(http(`${ADDRESSES}\n    bucket = "b"`));

      expect(error.message).toBe(
        'backend "http" takes only "address", "update_method", "lock_address", "lock_method", "unlock_address", "unlock_method", "ca_certificate", "retry_max", "retry_wait_min", "retry_wait_max", "timeout", not "bucket"'
      );
      expect(error.position).toMatchObject({ line: 5, column: 14 });
    });

    it('takes how it tries a request again, in seconds, and fills in the rest', () => {
      const { settings } = (backendFrom(http(`${ADDRESSES}\n    retry_max = 5\n    timeout = 90`), dir, {}) as HttpBackend).choice;

      expect(settings).toMatchObject({ retry_max: 5, retry_wait_min: 1, retry_wait_max: 30, timeout: 90 });
    });

    it.each([
      ['a string', 'timeout = "30"', 'timeout of backend "http" is a number written out'],
      ['a fraction', 'timeout = 1.5', 'timeout of backend "http" is 1.5, which is not a whole number'],
      ['no time', 'timeout = 0', 'timeout of backend "http" is 0, and it takes 1 to 3600 seconds'],
      ['too long a wait', 'retry_wait_max = 3601', 'retry_wait_max of backend "http" is 3601, and it takes 0 to 3600 seconds'],
      ['fewer than no tries', 'retry_max = -1', 'retry_max of backend "http" is -1, and it takes 0 to 100 tries'],
      ['a shortest wait above the longest', 'retry_wait_min = 10\n    retry_wait_max = 5', 'retry_wait_min of backend "http" is 10, longer than retry_wait_max, 5'],
    ])('refuses %s, at the value', (_title, body, message) => {
      const error = errorOf(http(`${ADDRESSES}\n    ${body}`));
      const name = body.split(' ')[0];

      expect(error.message).toBe(message);
      expect(error.position).toMatchObject({ line: 5, column: name.length + 8 });
    });

    it.each([
      ['username', 'CLAY_HTTP_USERNAME'],
      ['password', 'CLAY_HTTP_PASSWORD'],
    ])('refuses a %s in the block, naming where it is read from, at the value', (name, variable) => {
      const error = errorOf(http(`${ADDRESSES}\n    ${name} = "secret"`));

      expect(error.message).toBe(`${name} of backend "http" is read from ${variable}, never from the configuration, which is checked in`);
      expect(error.message).not.toContain('secret');
      expect(error.position).toMatchObject({ line: 5, column: 16 });
    });
  });

  describe('of type s3', () => {
    const PLACE = 'bucket = "b"\n    key = "env/state.json"\n    region = "eu-west-1"';

    it('keeps the state at its key in the bucket', () => {
      const backend = backendFrom(s3(PLACE), dir, {});

      expect(backend).toBeInstanceOf(S3Backend);
      expect(backend.location).toBe('s3://b/env/state.json');
      expect(backend.choice.settings).toEqual({ bucket: 'b', key: 'env/state.json', region: 'eu-west-1', use_path_style: false });
    });

    it('takes an endpoint and the bucket in the path, for a server other than AWS', () => {
      const choice = choiceOf(`${PLACE}\n    endpoint = "http://127.0.0.1:9000"\n    use_path_style = true`);

      expect(choice.where).toBe('s3://b/env/state.json at http://127.0.0.1:9000/');
      expect(choice.settings).toMatchObject({ endpoint: 'http://127.0.0.1:9000/', use_path_style: true });
    });

    it.each([
      ['AWS_REGION', { AWS_REGION: 'us-east-2', AWS_DEFAULT_REGION: 'us-west-1' }],
      ['AWS_DEFAULT_REGION', { AWS_REGION: '', AWS_DEFAULT_REGION: 'us-west-1' }],
    ])('does not record a region from %s', (_name, env) => {
      const backend = backendFrom(s3('bucket = "b"\n    key = "k"'), dir, env) as S3Backend;

      expect(backend.choice.settings).toEqual({ bucket: 'b', key: 'k', use_path_style: false });
    });

    it('refuses a block with no region where the environment has none, at its label', () => {
      const error = errorOf(s3('bucket = "b"\n    key = "k"'), { AWS_REGION: '' });

      expect(error.message).toBe('backend "s3" needs "region", or AWS_REGION or AWS_DEFAULT_REGION in the environment');
      expect(error.position).toMatchObject({ line: 2, column: 11 });
    });

    it('refuses a region from the environment that is no region, naming the variable, at the label', () => {
      const error = errorOf(s3('bucket = "b"\n    key = "k"'), { AWS_REGION: 'eu west' });

      expect(error.message).toBe('AWS_REGION is "eu west", which is no region');
      expect(error.position).toMatchObject({ line: 2, column: 11 });
    });

    it.each([
      ['bucket', 'key = "k"\n    region = "eu-west-1"'],
      ['key', 'bucket = "b"\n    region = "eu-west-1"'],
    ])('refuses a block with no %s, at its label', (name, body) => {
      const error = errorOf(s3(body));

      expect(error.message).toBe(`backend "s3" needs "${name}"`);
      expect(error.position).toMatchObject({ line: 2, column: 11 });
    });

    it.each([
      ['a bucket with a slash', 'bucket = "b/c"', 'bucket of backend "s3" is "b/c", and a bucket name holds no "/"'],
      ['a key starting with a slash', 'key = "/k"', 'key of backend "s3" is "/k", which must not start or end with "/"'],
      ['a key ending with a slash', 'key = "k/"', 'key of backend "s3" is "k/", which must not start or end with "/"'],
      ['a key with an empty part', 'key = "a//k"', 'key of backend "s3" is "a//k", which must not hold "//"'],
      ['a region that is no region', 'region = "EU_WEST"', 'region of backend "s3" is "EU_WEST", which is no region'],
      ['an endpoint that is no URL', 'endpoint = "s3.local"', 'endpoint of backend "s3" is "s3.local", which is not a URL'],
      ['an endpoint of another scheme', 'endpoint = "ftp://s3.local"', 'endpoint of backend "s3" is "ftp://s3.local", and only http and https are taken'],
      ['an endpoint with credentials', 'endpoint = "https://me:secret@s3.local"', 'endpoint of backend "s3" holds credentials, which would be printed wherever the address is'],
      ['a path style that is no boolean', 'use_path_style = "yes"', 'use_path_style of backend "s3" is true or false written out'],
    ])('refuses %s, at the value', (_title, line, message) => {
      const [name] = line.split(' ');
      const others = PLACE.split('\n    ').filter((setting) => !setting.startsWith(`${name} `));
      const error = errorOf(s3([line, ...others].join('\n    ')));

      expect(error.message).toBe(message);
      expect(error.position).toMatchObject({ line: 3, column: name.length + 8 });
    });

    it.each([
      ['access_key', 'AWS_ACCESS_KEY_ID'],
      ['secret_key', 'AWS_SECRET_ACCESS_KEY'],
      ['token', 'AWS_SESSION_TOKEN'],
    ])('refuses %s in the block, naming where it is read from, at the value', (name, variable) => {
      const error = errorOf(s3(`${PLACE}\n    ${name} = "secret"`));

      expect(error.message).toBe(`${name} of backend "s3" is read from ${variable}, a profile or a role, never from the configuration, which is checked in`);
      expect(error.position).toMatchObject({ line: 6, column: name.length + 8 });
    });

    it('refuses an attribute it does not take, naming those it does', () => {
      const error = errorOf(s3(`${PLACE}\n    profile = "work"`));

      expect(error.message).toBe('backend "s3" takes only "bucket", "key", "region", "endpoint", "use_path_style", not "profile"');
      expect(error.position).toMatchObject({ line: 6, column: 15 });
    });
  });
});
