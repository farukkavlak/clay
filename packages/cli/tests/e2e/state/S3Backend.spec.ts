import { newLockInfo } from '@clay/state';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { S3StateServer } from '../../../../../tests/s3StateServer';
import { clay } from '../helpers';

const FILE = 'resource "local_file" "f" {\n  path    = "f.txt"\n  content = "x"\n}\n';

/** No credentials, profile or region of the machine the tests run on reaches the CLI. */
const AWS_UNSET = {
  AWS_ACCESS_KEY_ID: '',
  AWS_SECRET_ACCESS_KEY: '',
  AWS_SESSION_TOKEN: '',
  AWS_PROFILE: '',
  AWS_REGION: '',
  AWS_DEFAULT_REGION: '',
  AWS_SHARED_CREDENTIALS_FILE: '/nonexistent/credentials',
  AWS_CONFIG_FILE: '/nonexistent/config',
  AWS_EC2_METADATA_DISABLED: 'true',
};
const CREDENTIALS = { AWS_ACCESS_KEY_ID: 'test-key', AWS_SECRET_ACCESS_KEY: 'test-secret' };

describe('a state kept in S3', () => {
  let dir: string;
  let server: S3StateServer;

  /** What the CLI printed and exited with, run with `env` over the test's AWS settings. */
  const run = async (env: Record<string, string>, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    try {
      const { stdout, stderr } = await promisify(execFile)('node', [clay, ...args], { cwd: dir, env: { ...process.env, ...AWS_UNSET, ...env } });
      return { code: 0, stdout: stripVTControlCharacters(stdout), stderr: stripVTControlCharacters(stderr) };
    } catch (error) {
      const failed = error as { code: number; stdout: string; stderr: string };
      return { code: failed.code, stdout: stripVTControlCharacters(failed.stdout), stderr: stripVTControlCharacters(failed.stderr) };
    }
  };
  const clayWith = (...args: string[]) => run(CREDENTIALS, ...args);

  const configure = (...more: string[]) =>
    fs.writeFile(
      path.join(dir, 'main.clay'),
      `clay {\n  backend "s3" {\n    bucket         = "bucket"\n    key            = "env/state.json"\n    endpoint       = "${server.url}"\n    use_path_style = true\n${more.map((line) => `    ${line}\n`).join('')}  }\n}\n${FILE}`,
      'utf8'
    );

  const stateInBucket = () => JSON.parse(server.text('bucket/env/state.json')!) as { serial: number; resources: Record<string, unknown> };
  const exists = (name: string) =>
    fs.access(path.join(dir, name)).then(
      () => true,
      () => false
    );

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-s3-backend-'));
    server = await S3StateServer.start();
    server.accessKey = 'test-key';
    await configure('region         = "eu-west-1"');
  });

  afterEach(async () => {
    await server.stop();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('is started in the bucket by init, and nothing in the workspace', async () => {
    const { code, stdout } = await clayWith('init');

    expect(code).toBe(0);
    expect(stdout).toContain('Created an empty state');
    expect(stateInBucket()).toMatchObject({ serial: 0, resources: {} });
    expect(server.text('bucket/env/state.json.lock')).toBeUndefined();
    expect(await exists('clay.state.json')).toBe(false);
    expect(JSON.parse(await fs.readFile(path.join(dir, '.clay', 'backend.json'), 'utf8'))).toEqual({
      type: 's3',
      settings: { bucket: 'bucket', key: 'env/state.json', region: 'eu-west-1', endpoint: `${server.url}/`, use_path_style: true },
    });
  });

  it('is written by apply under the lock it takes, and the lock released', async () => {
    await clayWith('init');
    server.received.length = 0;

    const { code, stdout } = await clayWith('apply', '--yes');

    expect(code).toBe(0);
    expect(stdout).toContain('Apply complete! Resources: 1 added');
    expect(Object.keys(stateInBucket().resources)).toEqual(['local_file.f']);
    expect(server.received[0]).toMatchObject({ method: 'PUT', path: '/bucket/env/state.json.lock', ifNoneMatch: '*' });
    expect(server.received.at(-1)).toMatchObject({ method: 'DELETE', path: '/bucket/env/state.json.lock', ifMatch: expect.stringMatching(/^"[0-9a-f]{32}"$/) });
    expect(server.text('bucket/env/state.json.lock')).toBeUndefined();
    expect(await exists('clay.state.json')).toBe(false);
  });

  it('releases the lock a run that died left, with force-unlock', async () => {
    await clayWith('init');
    const holder = { ...newLockInfo('apply'), host: 'elsewhere' };
    server.put('bucket/env/state.json.lock', JSON.stringify(holder));

    const { code } = await clayWith('force-unlock', holder.id);

    expect(code).toBe(0);
    expect(server.text('bucket/env/state.json.lock')).toBeUndefined();
  });

  it('refuses a run while another holds the lock, naming how to free it, and writes nothing', async () => {
    await clayWith('init');
    const holder = { ...newLockInfo('apply'), host: 'elsewhere' };
    server.put('bucket/env/state.json.lock', JSON.stringify(holder));

    const { code, stderr } = await clayWith('apply', '--yes');

    expect(code).toBe(1);
    expect(stderr).toContain(`State is locked by apply of ${holder.who} on elsewhere, pid ${holder.pid}`);
    expect(stderr).toContain(`If that run is gone, run clay force-unlock ${holder.id}`);
    expect(stateInBucket().resources).toEqual({});
    expect(server.text('bucket/env/state.json.lock')).toBe(JSON.stringify(holder));
    expect(await exists('f.txt')).toBe(false);
  });

  it('takes the region from the environment, and init records none', async () => {
    await configure();

    const { code } = await run({ ...CREDENTIALS, AWS_REGION: 'ap-south-2' }, 'init');

    expect(code).toBe(0);
    expect(server.received.length).toBeGreaterThan(0);
    expect(server.received.map(({ region }) => region)).toEqual(server.received.map(() => 'ap-south-2'));
    expect(JSON.parse(await fs.readFile(path.join(dir, '.clay', 'backend.json'), 'utf8'))).toMatchObject({ settings: { bucket: 'bucket' } });
    expect(JSON.parse(await fs.readFile(path.join(dir, '.clay', 'backend.json'), 'utf8'))).not.toHaveProperty('settings.region');
  });

  it('is refused by init where no region is named, at the block', async () => {
    await configure();

    const { code, stderr } = await clayWith('init');

    expect(code).toBe(1);
    expect(stderr).toContain('backend "s3" needs "region", or AWS_REGION or AWS_DEFAULT_REGION in the environment');
    expect(stderr).toContain('on main.clay line 2');
    expect(server.received).toEqual([]);
  });

  it('is refused where no credentials are found, naming where to give them', async () => {
    const { code, stderr } = await run({}, 'init');

    expect(code).toBe(1);
    expect(stderr).toContain('found no AWS credentials; give them in AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, a profile or a role');
    expect(server.received).toEqual([]);
    expect(await exists('.clay')).toBe(false);
  });

  it('is refused where S3 refuses the credentials, naming what it answered', async () => {
    const { code, stderr } = await run({ ...CREDENTIALS, AWS_ACCESS_KEY_ID: 'another-key' }, 'init');

    expect(code).toBe(1);
    expect(stderr).toContain(`answered 403 InvalidAccessKeyId`);
    expect(await exists('.clay')).toBe(false);
  });

  it('takes a local state into the bucket with init --yes', async () => {
    await fs.writeFile(path.join(dir, 'main.clay'), FILE, 'utf8');
    await clayWith('init');
    await clayWith('apply', '--yes');
    await configure('region         = "eu-west-1"');

    const { code, stdout } = await clayWith('init', '--yes');

    expect(code).toBe(0);
    expect(stdout).toContain(`Moved the state in "clay.state.json" to "s3://bucket/env/state.json at ${server.url}/"`);
    expect(Object.keys(stateInBucket().resources)).toEqual(['local_file.f']);
    expect(server.text('bucket/env/state.json.lock')).toBeUndefined();
    const plan = await clayWith('plan');
    expect(plan.stdout).toContain('No changes');
  });
});
