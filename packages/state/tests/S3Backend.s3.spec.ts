import { emptyState } from '@clay/contracts';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { RealS3 } from '../../../tests/realS3';
import { newLockInfo, serializeState, StateLocked } from '../src';
import { S3Backend } from '../src/backends/S3Backend';

const resource = { resourceType: 'local_file', name: 'a', attributes: { path: 'a.txt' } };
const stateWith = (serial: number) => ({ ...emptyState(), serial, resources: { 'local_file.a': resource } });

const KEY = 'env/state.json';
const LOCK = `${KEY}.lock`;

describe('a state kept on a real S3 server', () => {
  let s3: RealS3;
  let bucket = '';

  const backendIn = (name = bucket) =>
    new S3Backend({ bucket: name, key: KEY, region: 'us-east-1', regionInBlock: true, endpoint: new URL(s3.endpoint), pathStyle: true }, { timeout: 10, attempts: 1 });

  beforeAll(() => {
    s3 = RealS3.fromEnv();
  });

  afterAll(() => s3?.close());

  beforeEach(async () => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', s3.accessKey);
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', s3.secretKey);
    vi.stubEnv('AWS_SESSION_TOKEN', '');
    vi.stubEnv('AWS_PROFILE', '');
    bucket = '';
    bucket = await s3.newBucket();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (bucket !== '') await s3.removeBucket(bucket);
  });

  it('writes the state whole and reads it back', async () => {
    expect(await backendIn().exists()).toBe(false);

    await backendIn().write(stateWith(3));

    expect(await s3.text(bucket, KEY)).toBe(serializeState(stateWith(3)));
    expect(await backendIn().read()).toEqual(stateWith(3));
  });

  it('writes a first state only where none is', async () => {
    expect(await backendIn().writeIfAbsent(stateWith(1))).toBe(true);
    expect(await backendIn().writeIfAbsent(stateWith(2))).toBe(false);

    expect(await s3.text(bucket, KEY)).toBe(serializeState(stateWith(1)));
  });

  it('names a bucket the server does not have', async () => {
    await expect(backendIn(`clay-missing-${randomUUID()}`).check()).rejects.toThrow('answered 404 NoSuchBucket');
  });

  describe('its lock', () => {
    it('is taken by one of many runs that try at once, and refused to the rest naming it', async () => {
      const runs = Array.from({ length: 10 }, () => newLockInfo('apply'));

      const tries = await Promise.allSettled(runs.map((info) => backendIn().lock(info)));

      const taken = runs.filter((_info, at) => tries[at].status === 'fulfilled');
      expect(taken).toHaveLength(1);
      expect(JSON.parse((await s3.text(bucket, LOCK))!)).toEqual(taken[0]);
      for (const refused of tries.filter((each) => each.status === 'rejected')) {
        expect(refused.reason).toBeInstanceOf(StateLocked);
        expect(refused.reason.message).toContain(`pid ${taken[0].pid}`);
      }
    });

    it('is released by the run that took it', async () => {
      const info = newLockInfo('apply');
      await backendIn().lock(info);

      await backendIn().unlock(info.id);

      expect(await s3.text(bucket, LOCK)).toBeUndefined();
      await backendIn().lock(newLockInfo('plan'));
    });

    it('counts as released where it was removed by hand', async () => {
      const info = newLockInfo('apply');
      await backendIn().lock(info);
      await s3.remove(bucket, LOCK);

      await expect(backendIn().unlock(info.id)).resolves.toBeUndefined();
    });

    it('is left in place where another run holds it', async () => {
      const other = newLockInfo('plan');
      await backendIn().lock(other);

      await expect(backendIn().unlock(newLockInfo('apply').id)).rejects.toThrow('holds a lock this run did not take, so it is left in place');
      expect(JSON.parse((await s3.text(bucket, LOCK))!)).toEqual(other);
    });
  });
});
