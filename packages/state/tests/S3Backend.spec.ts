import { emptyState } from '@clay/contracts';
import { BackendBlock, parseModule } from '@clay/parser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { S3StateServer } from '../../../tests/s3StateServer';
import { backendFrom, newLockInfo, serializeState, StateLocked } from '../src';
import { NoAnswer } from '../src/backends/httpRequest';
import { S3Backend, S3Limits } from '../src/backends/S3Backend';

const resource = { resourceType: 'local_file', name: 'a', attributes: { path: 'a.txt' } };
const stateWith = (serial: number) => ({ ...emptyState(), lineage: 'lineage', serial, resources: { 'local_file.a': resource } });

/** One try, so a test of one failing answer sees it. */
const ONCE: S3Limits = { timeout: 5, attempts: 1 };

describe('a state kept in S3', () => {
  let server: S3StateServer;

  const backendOn = (limits: S3Limits = ONCE, key = 'env/state.json') =>
    new S3Backend({ bucket: 'bucket', key, region: 'eu-west-1', regionInBlock: true, endpoint: new URL(server.url), pathStyle: true }, limits);

  const sent = () => server.received.map(({ method, path }) => `${method} ${path}`);
  const named = (name = 'dev', limits: S3Limits = ONCE, key = 'env/state.json') => backendOn(limits, key).workspace(name);
  const put = (key: string, body = serializeState(stateWith(1))) => server.put(`bucket/${key}`, body);
  const listings = () => sent().filter((request) => request.replace(/\/$/, '') === 'GET /bucket').length;

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

    await backendFrom(block, '/project', env).read();

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
    expect(server.received.filter(({ method }) => method === 'PUT').map(({ ifNoneMatch }) => ifNoneMatch)).toEqual(['*', '*']);
  });

  it('names the place and what S3 answered, where it refuses a request', async () => {
    server.accessKey = 'another-key';

    await expect(backendOn().read()).rejects.toThrow(
      `GetObject s3://bucket/env/state.json at ${server.url}/ answered 403 InvalidAccessKeyId: InvalidAccessKeyId from the test server`
    );
    await expect(backendOn().write({ ...emptyState(), lineage: 'lineage' })).rejects.toThrow(
      `PutObject s3://bucket/env/state.json at ${server.url}/ answered 403 InvalidAccessKeyId`
    );
    await expect(backendOn().writeIfAbsent({ ...emptyState(), lineage: 'lineage' })).rejects.toThrow('answered 403 InvalidAccessKeyId');
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
      await expect(taken).rejects.toThrow(`If that run is gone, run clay force-unlock ${holder.id}`);
      expect(JSON.parse(server.text('bucket/env/state.json.lock')!)).toEqual(holder);
    });

    it('says to remove a lock that names no run', async () => {
      server.put('bucket/env/state.json.lock', 'locked');

      await expect(backendOn().lock(newLockInfo('apply'))).rejects.toThrow(
        `State is locked by a run that left no word of who it is. If that run is gone, remove s3://bucket/env/state.json.lock at ${server.url}/`
      );
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
        `PutObject s3://bucket/env/state.json.lock at ${server.url}/ got no answer (ECONNRESET). S3 may hold lock ${info.id} all the same; if it does, run clay force-unlock ${info.id}`
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
      const other = newLockInfo('plan');
      await backendOn().lock(info);
      server.override('DELETE /bucket/env/state.json.lock', { before: () => server.put('bucket/env/state.json.lock', JSON.stringify(other)) });

      await expect(backendOn().unlock(info.id)).rejects.toThrow('holds a lock this run did not take, so it is left in place');
      expect(JSON.parse(server.text('bucket/env/state.json.lock')!)).toEqual(other);
    });

    it.each([
      ['404, as AWS does', []],
      ['412, as RustFS does', [{ status: 412, code: 'PreconditionFailed' }]],
    ])('counts as released where a try before the last deleted it, and the next is answered %s', async (_name, next) => {
      const info = newLockInfo('apply');
      await backendOn().lock(info);
      server.override('DELETE /bucket/env/state.json.lock', { lost: true }, ...next);
      server.received.length = 0;

      await backendOn({ timeout: 5, attempts: 2 }).unlock(info.id);

      expect(server.text('bucket/env/state.json.lock')).toBeUndefined();
      expect(sent()).toEqual(['GET /bucket/env/state.json.lock', 'DELETE /bucket/env/state.json.lock', 'DELETE /bucket/env/state.json.lock', 'GET /bucket/env/state.json.lock']);
    });

    it('is deleted again where a request on it at the same time made S3 answer 409', async () => {
      const info = newLockInfo('apply');
      await backendOn().lock(info);
      server.override('DELETE /bucket/env/state.json.lock', { status: 409, code: 'ConditionalRequestConflict' });
      server.received.length = 0;

      await backendOn().unlock(info.id);

      expect(server.text('bucket/env/state.json.lock')).toBeUndefined();
      expect(sent()).toEqual(['GET /bucket/env/state.json.lock', 'DELETE /bucket/env/state.json.lock', 'GET /bucket/env/state.json.lock', 'DELETE /bucket/env/state.json.lock']);
    });

    it('names what S3 answered where the delete is refused twice and the lock is still there', async () => {
      const info = newLockInfo('apply');
      await backendOn().lock(info);
      const conflict = { status: 409, code: 'ConditionalRequestConflict' };
      server.override('DELETE /bucket/env/state.json.lock', conflict, conflict);

      await expect(backendOn().unlock(info.id)).rejects.toThrow(`DeleteObject s3://bucket/env/state.json.lock at ${server.url}/ answered 409 ConditionalRequestConflict`);
      expect(JSON.parse(server.text('bucket/env/state.json.lock')!)).toEqual(info);
    });

    it('names what S3 answered to a delete it refused', async () => {
      const info = newLockInfo('apply');
      await backendOn().lock(info);
      server.override('DELETE /bucket/env/state.json.lock', { status: 403, code: 'AccessDenied' });

      await expect(backendOn().unlock(info.id)).rejects.toThrow(`DeleteObject s3://bucket/env/state.json.lock at ${server.url}/ answered 403 AccessDenied`);
    });
  });

  describe('its lock forced open', () => {
    it('is released for a run that is gone', async () => {
      const gone = newLockInfo('apply');
      await backendOn().lock(gone);

      await backendOn().forceUnlock(gone.id);

      expect(server.text('bucket/env/state.json.lock')).toBeUndefined();
    });

    it('is left in place where it has another id', async () => {
      const other = newLockInfo('plan');
      await backendOn().lock(other);

      await expect(backendOn().forceUnlock('another')).rejects.toThrow(
        `s3://bucket/env/state.json.lock at ${server.url}/ holds lock ${other.id}, not another, so it is left in place`
      );
      expect(JSON.parse(server.text('bucket/env/state.json.lock')!)).toEqual(other);
    });

    it('is left in place where it names no run', async () => {
      server.put('bucket/env/state.json.lock', 'locked');

      await expect(backendOn().forceUnlock('another')).rejects.toThrow(
        `s3://bucket/env/state.json.lock at ${server.url}/ holds a lock that names no run, not another, so it is left in place`
      );
      expect(server.text('bucket/env/state.json.lock')).toBe('locked');
    });

    it('says no lock is held where none is', async () => {
      await expect(backendOn().forceUnlock('another')).rejects.toThrow(`No lock is held at s3://bucket/env/state.json.lock at ${server.url}/`);
    });
  });

  describe('its workspaces', () => {
    const DEV = 'env/clay.workspaces/dev/state.json';

    it('keeps one next to the default state, with its own lock, and is chosen as the default one is', async () => {
      const workspace = named();
      const info = newLockInfo('apply');
      await workspace.prepare?.();

      await workspace.lock(info);
      await workspace.write(stateWith(1));

      expect(workspace.location).toBe(`s3://bucket/${DEV} at ${server.url}/`);
      expect(workspace.choice).toEqual(backendOn().choice);
      expect(server.text(`bucket/${DEV}`)).toBe(serializeState(stateWith(1)));
      expect(JSON.parse(server.text(`bucket/${DEV}.lock`)!)).toEqual(info);
      expect(server.text('bucket/env/state.json')).toBeUndefined();
    });

    it('keeps one at the top of the bucket where the key has no folder', () => {
      expect(named('dev', ONCE, 'state.json').location).toBe(`s3://bucket/clay.workspaces/dev/state.json at ${server.url}/`);
    });

    it('is the default state again under the name default', () => {
      expect(named('default').location).toBe(backendOn().location);
    });

    it('lists default first, then the names with a state of the default file name, in order', async () => {
      for (const key of [
        DEV,
        'env/clay.workspaces/a/state.json',
        'env/clay.workspaces/a-1/state.json',
        'env/clay.workspaces/gone/state.json.lock',
        'env/clay.workspaces/other/b.json',
      ])
        put(key);
      for (const key of [
        'env/clay.workspaces/deep/er/state.json',
        'env/clay.workspaces/deep/state.json/state.json',
        'env/clay.workspaces/Bad_Name/state.json',
        'env/clay.workspaces/default/state.json',
        'clay.workspaces/top/state.json',
      ])
        put(key);
      put('env/clay.workspaces/empty/state.json', '');

      expect(await backendOn().listWorkspaces()).toEqual(['default', 'a', 'a-1', 'dev']);
    });

    it('lists default alone where no workspace is', async () => {
      expect(await backendOn().listWorkspaces()).toEqual(['default']);
    });

    it('lists the same from a named workspace', async () => {
      put(DEV);

      expect(await named('other').listWorkspaces()).toEqual(['default', 'dev']);
    });

    it('reads every page of the listing', async () => {
      server.pageSize = 2;
      for (const name of ['a', 'b', 'c', 'd', 'e']) put(`env/clay.workspaces/${name}/state.json`);

      expect(await backendOn().listWorkspaces()).toEqual(['default', 'a', 'b', 'c', 'd', 'e']);
      expect(listings()).toBe(3);
    });

    it('refuses a listing cut short with no way to go on', async () => {
      server.override('GET /bucket/', { raw: 200, body: '<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>' });
      server.override('GET /bucket', { raw: 200, body: '<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>' });

      await expect(backendOn().listWorkspaces()).rejects.toThrow(`The listing of s3://bucket/env/clay.workspaces/ at ${server.url}/ was cut short with no way to go on`);
    });

    it('names the permission a refused listing needs', async () => {
      server.override('GET /bucket/', { status: 403, code: 'AccessDenied' });
      server.override('GET /bucket', { status: 403, code: 'AccessDenied' });

      await expect(backendOn().listWorkspaces()).rejects.toThrow(
        `S3 refused to list s3://bucket/env/clay.workspaces/ at ${server.url}/; finding workspaces needs s3:ListBucket on bucket "bucket"`
      );
    });

    it('says what S3 answered to a listing it failed for another reason', async () => {
      server.override('GET /bucket/', { status: 404, code: 'NoSuchBucket' });
      server.override('GET /bucket', { status: 404, code: 'NoSuchBucket' });

      await expect(backendOn().listWorkspaces()).rejects.toThrow(`ListObjectsV2 s3://bucket/env/clay.workspaces/ at ${server.url}/ answered 404 NoSuchBucket`);
    });

    it('exists only with its state', async () => {
      expect(await named().exists()).toBe(false);
      put(DEV);

      expect(await named().exists()).toBe(true);
    });

    it('is not read as empty once its state is gone', async () => {
      await expect(named().read()).rejects.toThrow('Workspace "dev" does not exist');
    });

    it('refuses a lock on a workspace deleted meanwhile, and leaves no lock', async () => {
      await expect(named().lock(newLockInfo('apply'))).rejects.toThrow('Workspace "dev" does not exist');

      expect(server.text(`bucket/${DEV}.lock`)).toBeUndefined();
    });

    it('gives the lock back where its state cannot be read, and says why', async () => {
      put(DEV);
      server.override(`GET /bucket/${DEV}`, { status: 403, code: 'AccessDenied' });

      await expect(named().lock(newLockInfo('apply'))).rejects.toThrow(`GetObject s3://bucket/${DEV} at ${server.url}/ answered 403 AccessDenied`);
      expect(server.text(`bucket/${DEV}.lock`)).toBeUndefined();
    });

    it('says how to free a lock it could not give back, and still why it stopped', async () => {
      const info = newLockInfo('apply');
      server.override(`GET /bucket/${DEV}.lock`, { status: 403, code: 'AccessDenied' });

      await expect(named().lock(info)).rejects.toThrow(`Workspace "dev" does not exist. The lock could not be released; run clay force-unlock ${info.id}`);
      expect(server.text(`bucket/${DEV}.lock`)).toBeDefined();
    });

    it('is locked where its state exists', async () => {
      put(DEV);
      const info = newLockInfo('apply');

      await named().lock(info);

      expect(JSON.parse(server.text(`bucket/${DEV}.lock`)!)).toEqual(info);
    });

    it('removes only its state', async () => {
      put(DEV);
      put(`${DEV}.lock`, 'held');
      put('env/state.json');

      await named().remove();
      await named().prune();

      expect(server.text(`bucket/${DEV}`)).toBeUndefined();
      expect(server.text(`bucket/${DEV}.lock`)).toBe('held');
      expect(server.text('bucket/env/state.json')).toBeDefined();
    });

    it('never removes the default state', async () => {
      put('env/state.json');

      await expect(named('default').remove()).rejects.toThrow('The state of the default workspace is not removed');
      expect(server.text('bucket/env/state.json')).toBeDefined();
    });

    it('says what S3 answered to a removal it refused', async () => {
      server.override(`DELETE /bucket/${DEV}`, { status: 403, code: 'AccessDenied' });

      await expect(named().remove()).rejects.toThrow(`DeleteObject s3://bucket/${DEV} at ${server.url}/ answered 403 AccessDenied`);
    });

    it('takes the longest key whose lock fits', async () => {
      await expect(named('dev', ONCE, 'k'.repeat(999)).prepare?.()).resolves.toBeUndefined();
    });

    it.each([
      ['characters', 'k'.repeat(1000)],
      ['bytes in UTF-8', 'ü'.repeat(500)],
    ])('refuses a workspace whose lock would not fit, counting %s', async (_title, key) => {
      await expect(named('dev', ONCE, key).prepare?.()).rejects.toThrow(
        'The lock of workspace "dev" would have a key of 1025 bytes, and S3 takes 1024 at most; use a shorter key in the backend block'
      );
    });

    it('counts a first write as done where the answer was lost and the try sent again finds it', async () => {
      server.override(`PUT /bucket/${DEV}`, { lost: true });

      expect(await named('dev', { timeout: 5, attempts: 2 }).writeIfAbsent(stateWith(1))).toBe(true);
      expect(server.text(`bucket/${DEV}`)).toBe(serializeState(stateWith(1)));
    });

    it('does not write over another state', async () => {
      put(DEV, serializeState(stateWith(2)));

      expect(await named().writeIfAbsent(stateWith(1))).toBe(false);
      expect(server.text(`bucket/${DEV}`)).toBe(serializeState(stateWith(2)));
    });

    it('writes over an empty object, which is no state', async () => {
      put(DEV, '');

      expect(await named().writeIfAbsent(stateWith(1))).toBe(true);
      expect(server.text(`bucket/${DEV}`)).toBe(serializeState(stateWith(1)));
    });
  });
});
