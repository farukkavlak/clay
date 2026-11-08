import { emptyState } from '@clay/contracts';
import { BackendBlock, parseModule } from '@clay/parser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { S3StateServer } from '../../../tests/s3StateServer';
import { backendFrom, newLockInfo, serializeState, StateLocked } from '../src';
import { NoAnswer } from '../src/backends/httpRequest';
import { S3Backend, S3Limits } from '../src/backends/S3Backend';

const resource = { resourceType: 'local_file', name: 'a', attributes: { path: 'a.txt' } };
const stateWith = (serial: number) => ({ ...emptyState(), serial, resources: { 'local_file.a': resource } });

/** One try, so a test of one failing answer sees it. */
const ONCE: S3Limits = { timeout: 5, attempts: 1 };

describe('a state kept in S3', () => {
  let server: S3StateServer;

  const backendOn = (limits: S3Limits = ONCE, key = 'env/state.json') =>
    new S3Backend({ bucket: 'bucket', key, region: 'eu-west-1', regionInBlock: true, endpoint: new URL(server.url), pathStyle: true }, limits);

  const sent = () => server.received.map(({ method, path }) => `${method} ${path}`);

  beforeEach(async () => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'test-key');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'test-secret');
    server = await S3StateServer.start();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await server.stop();
  });

  it('is named by its bucket, key and endpoint, and chosen with every setting the block gives', () => {
    const backend = backendOn();

    expect(backend.location).toBe(`s3://bucket/env/state.json at ${server.url}/`);
    expect(backend.choice).toEqual({
      type: 's3',
      where: `s3://bucket/env/state.json at ${server.url}/`,
      settings: { bucket: 'bucket', key: 'env/state.json', region: 'eu-west-1', endpoint: `${server.url}/`, use_path_style: true },
    });
  });

  it('is named by its bucket and key alone on AWS, and leaves out a region the environment gave', () => {
    const backend = new S3Backend({ bucket: 'b', key: 'k', region: 'eu-west-1', regionInBlock: false, pathStyle: false });

    expect(backend.location).toBe('s3://b/k');
    expect(backend.choice.settings).toEqual({ bucket: 'b', key: 'k', use_path_style: false });
  });

  it.each([
    ['AWS_REGION', { AWS_REGION: 'ap-south-2', AWS_DEFAULT_REGION: 'us-west-1' }],
    ['AWS_DEFAULT_REGION', { AWS_DEFAULT_REGION: 'ap-south-2' }],
  ])('signs each request for the region %s names, where the block names none', async (_name, env) => {
    const block = parseModule([
      { file: 'main.clay', content: `clay {\n  backend "s3" {\n    bucket = "bucket"\n    key = "k"\n    endpoint = "${server.url}"\n    use_path_style = true\n  }\n}` },
    ])[0] as BackendBlock;

    await backendFrom(block, '/workspace', env).read();

    expect(server.received).toMatchObject([{ method: 'GET', path: '/bucket/k', region: 'ap-south-2' }]);
  });

  it.each([
    [false, 'bucket.s3.invalid'],
    [true, 's3.invalid'],
  ])('with the path style %s, asks the host %s', async (pathStyle, host) => {
    // .invalid never resolves, on any system, so the host asked is read from the error.
    const backend = new S3Backend({ bucket: 'bucket', key: 'k', region: 'eu-west-1', regionInBlock: true, endpoint: new URL('http://s3.invalid:9000'), pathStyle }, ONCE);

    const failed: unknown = await backend.read().catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(NoAnswer);
    expect((failed as NoAnswer).cause).toMatchObject({ hostname: host });
  });

  it('reads no object, or an empty one, as no state', async () => {
    expect(await backendOn().read()).toEqual(emptyState());
    expect(await backendOn().exists()).toBe(false);

    server.put('bucket/env/state.json', '');
    expect(await backendOn().exists()).toBe(false);
  });

  it('writes the state whole, signed with the credentials of the environment, and reads it back', async () => {
    server.accessKey = 'test-key';
    const backend = backendOn();

    await backend.write(stateWith(3));

    expect(server.text('bucket/env/state.json')).toBe(serializeState(stateWith(3)));
    expect(await backend.read()).toEqual(stateWith(3));
    expect(await backend.exists()).toBe(true);
    expect(sent()).toEqual(['PUT /bucket/env/state.json', 'GET /bucket/env/state.json', 'GET /bucket/env/state.json']);
  });

  it('writes a first state only where none is', async () => {
    const backend = backendOn();

    expect(await backend.writeIfAbsent(stateWith(1))).toBe(true);
    expect(await backend.writeIfAbsent(stateWith(2))).toBe(false);

    expect(server.text('bucket/env/state.json')).toBe(serializeState(stateWith(1)));
    expect(server.received.map(({ ifNoneMatch }) => ifNoneMatch)).toEqual(['*', '*']);
  });

  it('names the place and what S3 answered, where it refuses a request', async () => {
    server.accessKey = 'another-key';

    await expect(backendOn().read()).rejects.toThrow(
      `GetObject s3://bucket/env/state.json at ${server.url}/ answered 403 InvalidAccessKeyId: InvalidAccessKeyId from the test server`
    );
    await expect(backendOn().write(emptyState())).rejects.toThrow(`PutObject s3://bucket/env/state.json at ${server.url}/ answered 403 InvalidAccessKeyId`);
    await expect(backendOn().writeIfAbsent(emptyState())).rejects.toThrow('answered 403 InvalidAccessKeyId');
  });

  it('names a bucket the server does not have', async () => {
    const backend = new S3Backend({ bucket: 'missing', key: 'k', region: 'eu-west-1', regionInBlock: true, endpoint: new URL(server.url), pathStyle: true }, ONCE);

    await expect(backend.check()).rejects.toThrow(`GetObject s3://missing/k at ${server.url}/ answered 404 NoSuchBucket`);
  });

  it('says how often it tried a request that got no answer', async () => {
    server.override('GET /bucket/env/state.json', { lost: true }, { lost: true });

    const failed = backendOn({ timeout: 5, attempts: 2 }).read();

    await expect(failed).rejects.toThrow(NoAnswer);
    await expect(failed).rejects.toThrow(`GetObject s3://bucket/env/state.json at ${server.url}/ got no answer (ECONNRESET) after 2 tries`);
  });

  it('reads the state where the first try got no answer', async () => {
    server.put('bucket/env/state.json', serializeState(stateWith(4)));
    server.override('GET /bucket/env/state.json', { lost: true });

    expect(await backendOn({ timeout: 5, attempts: 2 }).read()).toEqual(stateWith(4));
  });

  it('passes on an error that is neither an answer of S3 nor a lost request', async () => {
    server.override('GET /bucket/env/state.json', { raw: 500, body: '<html>proxy error' });

    const failed = backendOn().read();

    await expect(failed).rejects.toThrow('XML parse error');
    await expect(failed).rejects.not.toThrow(NoAnswer);
  });

  it('gives up on a request that hangs past the time it takes', async () => {
    server.override('GET /bucket/env/state.json', { hang: true });

    const failed = backendOn({ timeout: 1, attempts: 1 }).read();

    await expect(failed).rejects.toThrow(NoAnswer);
    await expect(failed).rejects.toThrow(`GetObject s3://bucket/env/state.json at ${server.url}/ got no answer (timed out after 1s)`);
  });

  it('says where to give credentials, where none are found', async () => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', '');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', '');
    vi.stubEnv('AWS_PROFILE', '');
    vi.stubEnv('AWS_SHARED_CREDENTIALS_FILE', '/nonexistent/credentials');
    vi.stubEnv('AWS_CONFIG_FILE', '/nonexistent/config');
    vi.stubEnv('AWS_EC2_METADATA_DISABLED', 'true');

    await expect(backendOn().read()).rejects.toThrow(
      `GetObject s3://bucket/env/state.json at ${server.url}/ found no AWS credentials; give them in AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, a profile or a role`
    );
    expect(server.received).toEqual([]);
  });

  describe('its lock', () => {
    it('is an object beside the state, taken only where none is, and holding who took it', async () => {
      const info = newLockInfo('apply');

      await backendOn().lock(info);

      expect(JSON.parse(server.text('bucket/env/state.json.lock')!)).toEqual(info);
      expect(server.received).toMatchObject([{ method: 'PUT', path: '/bucket/env/state.json.lock', ifNoneMatch: '*' }]);
    });

    it('is refused while another run holds it, naming that run and how to free it', async () => {
      const holder = newLockInfo('plan');
      await backendOn().lock(holder);

      const taken = backendOn().lock(newLockInfo('apply'));

      await expect(taken).rejects.toThrow(StateLocked);
      await expect(taken).rejects.toThrow(`State is locked by plan of ${holder.who} on ${holder.host}`);
      await expect(taken).rejects.toThrow(`remove s3://bucket/env/state.json.lock at ${server.url}/`);
      expect(JSON.parse(server.text('bucket/env/state.json.lock')!)).toEqual(holder);
    });

    it('is tried once more where the lock it was refused for is gone when read', async () => {
      const holder = newLockInfo('plan');
      await backendOn().lock(holder);
      server.override('GET /bucket/env/state.json.lock', { status: 404, code: 'NoSuchKey' });
      server.received.length = 0;

      await expect(backendOn().lock(newLockInfo('apply'))).rejects.toThrow(`State is locked by plan of ${holder.who}`);
      expect(sent()).toEqual(['PUT /bucket/env/state.json.lock', 'GET /bucket/env/state.json.lock', 'PUT /bucket/env/state.json.lock', 'GET /bucket/env/state.json.lock']);
    });

    it('is taken on the next try where another request raced it and left no lock', async () => {
      const info = newLockInfo('apply');
      server.override('PUT /bucket/env/state.json.lock', { status: 409, code: 'ConditionalRequestConflict' });

      await backendOn().lock(info);

      expect(JSON.parse(server.text('bucket/env/state.json.lock')!)).toEqual(info);
      expect(sent()).toEqual(['PUT /bucket/env/state.json.lock', 'GET /bucket/env/state.json.lock', 'PUT /bucket/env/state.json.lock']);
    });

    it('is refused where another request raced it and holds it now', async () => {
      const holder = newLockInfo('plan');
      await backendOn().lock(holder);
      server.override('PUT /bucket/env/state.json.lock', { status: 409, code: 'ConditionalRequestConflict' });

      await expect(backendOn().lock(newLockInfo('apply'))).rejects.toThrow(`State is locked by plan of ${holder.who}`);
    });

    it('is taken where the answer to the first try was lost', async () => {
      const info = newLockInfo('apply');
      server.override('PUT /bucket/env/state.json.lock', { lost: true });

      await backendOn({ timeout: 5, attempts: 2 }).lock(info);

      expect(JSON.parse(server.text('bucket/env/state.json.lock')!)).toEqual(info);
      expect(sent()).toEqual(['PUT /bucket/env/state.json.lock', 'PUT /bucket/env/state.json.lock', 'GET /bucket/env/state.json.lock']);
    });

    it('says S3 may hold it, where no try got an answer', async () => {
      const info = newLockInfo('apply');
      server.override('PUT /bucket/env/state.json.lock', { lost: true });

      await expect(backendOn().lock(info)).rejects.toThrow(
        `PutObject s3://bucket/env/state.json.lock at ${server.url}/ got no answer (ECONNRESET). S3 may hold lock ${info.id} all the same; if it does, remove s3://bucket/env/state.json.lock at ${server.url}/`
      );
    });

    it('names what S3 answered to a request it refused', async () => {
      server.override('PUT /bucket/env/state.json.lock', { status: 403, code: 'AccessDenied' });

      await expect(backendOn().lock(newLockInfo('apply'))).rejects.toThrow(`PutObject s3://bucket/env/state.json.lock at ${server.url}/ answered 403 AccessDenied`);
    });

    it('is released with a delete that names the version this run took', async () => {
      const info = newLockInfo('apply');
      const backend = backendOn();
      await backend.lock(info);
      const { etag } = server.objects.get('bucket/env/state.json.lock')!;
      server.received.length = 0;

      await backend.unlock(info.id);

      expect(server.text('bucket/env/state.json.lock')).toBeUndefined();
      expect(server.received).toMatchObject([
        { method: 'GET', path: '/bucket/env/state.json.lock' },
        { method: 'DELETE', path: '/bucket/env/state.json.lock', ifMatch: etag },
      ]);
    });

    it('counts as released where it is gone already', async () => {
      await backendOn().unlock(newLockInfo('apply').id);

      expect(sent()).toEqual(['GET /bucket/env/state.json.lock']);
    });

    it('is left in place where another run holds it', async () => {
      const other = newLockInfo('plan');
      await backendOn().lock(other);

      await expect(backendOn().unlock(newLockInfo('apply').id)).rejects.toThrow(
        `s3://bucket/env/state.json.lock at ${server.url}/ holds a lock this run did not take, so it is left in place`
      );
      expect(JSON.parse(server.text('bucket/env/state.json.lock')!)).toEqual(other);
    });

    it('is left in place where another run took it between the read and the delete', async () => {
      const info = newLockInfo('apply');
      await backendOn().lock(info);
      server.override('DELETE /bucket/env/state.json.lock', { status: 412, code: 'PreconditionFailed' });

      await expect(backendOn().unlock(info.id)).rejects.toThrow('holds a lock this run did not take, so it is left in place');
    });

    it('counts as released where a try before the last deleted it', async () => {
      const info = newLockInfo('apply');
      await backendOn().lock(info);
      server.override('DELETE /bucket/env/state.json.lock', { status: 404, code: 'NoSuchKey' });
      server.received.length = 0;

      await backendOn().unlock(info.id);

      expect(sent()).toEqual(['GET /bucket/env/state.json.lock', 'DELETE /bucket/env/state.json.lock']);
    });

    it('names what S3 answered to a delete it refused', async () => {
      const info = newLockInfo('apply');
      await backendOn().lock(info);
      server.override('DELETE /bucket/env/state.json.lock', { status: 403, code: 'AccessDenied' });

      await expect(backendOn().unlock(info.id)).rejects.toThrow(`DeleteObject s3://bucket/env/state.json.lock at ${server.url}/ answered 403 AccessDenied`);
    });
  });
});
