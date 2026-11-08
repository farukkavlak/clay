import { newLockInfo } from '@clay/state';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { RealS3 } from '../../../../../tests/realS3';
import { clay } from '../helpers';

const FILE = 'resource "local_file" "f" {\n  path    = "f.txt"\n  content = "x"\n}\n';
const KEY = 'env/state.json';
const LOCK = `${KEY}.lock`;

describe('a state kept on a real S3 server', () => {
  let s3: RealS3;
  let bucket = '';
  let dir: string;

  /** What the CLI printed and exited with; no AWS setting of the machine the tests run on reaches it. */
  const clayWith = async (...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    const env = {
      ...process.env,
      AWS_ACCESS_KEY_ID: s3.accessKey,
      AWS_SECRET_ACCESS_KEY: s3.secretKey,
      AWS_SESSION_TOKEN: '',
      AWS_PROFILE: '',
      AWS_SHARED_CREDENTIALS_FILE: '/nonexistent/credentials',
      AWS_CONFIG_FILE: '/nonexistent/config',
    };
    try {
      const { stdout, stderr } = await promisify(execFile)('node', [clay, ...args], { cwd: dir, env });
      return { code: 0, stdout: stripVTControlCharacters(stdout), stderr: stripVTControlCharacters(stderr) };
    } catch (error) {
      const failed = error as { code: number; stdout: string; stderr: string };
      return { code: failed.code, stdout: stripVTControlCharacters(failed.stdout), stderr: stripVTControlCharacters(failed.stderr) };
    }
  };

  const resourcesInBucket = async () => {
    const state = JSON.parse((await s3.text(bucket, KEY))!) as { resources: Record<string, unknown> };
    return state.resources;
  };

  beforeAll(() => {
    s3 = RealS3.fromEnv();
  });

  afterAll(() => s3?.close());

  beforeEach(async () => {
    bucket = '';
    bucket = await s3.newBucket();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-s3-server-'));
    const backend = `  backend "s3" {\n    bucket         = "${bucket}"\n    key            = "${KEY}"\n    region         = "us-east-1"\n    endpoint       = "${s3.endpoint}"\n    use_path_style = true\n  }\n`;
    await fs.writeFile(path.join(dir, 'main.clay'), `clay {\n${backend}}\n${FILE}`, 'utf8');
  });

  afterEach(async () => {
    if (bucket !== '') await s3.removeBucket(bucket);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('is started by init, written by apply, and the lock released', async () => {
    const init = await clayWith('init');
    expect(init.code).toBe(0);

    const { code, stdout } = await clayWith('apply', '--yes');

    expect(code).toBe(0);
    expect(stdout).toContain('Apply complete! Resources: 1 added');
    expect(Object.keys(await resourcesInBucket())).toEqual(['local_file.f']);
    expect(await s3.text(bucket, LOCK)).toBeUndefined();
    const plan = await clayWith('plan');
    expect(plan.stdout).toContain('No changes');
  });

  it('refuses a run while another holds the lock, and writes nothing', async () => {
    await clayWith('init');
    const holder = { ...newLockInfo('apply'), host: 'elsewhere' };
    await s3.put(bucket, LOCK, JSON.stringify(holder));

    const { code, stderr } = await clayWith('apply', '--yes');

    expect(code).toBe(1);
    expect(stderr).toContain(`State is locked by apply of ${holder.who} on elsewhere, pid ${holder.pid}`);
    expect(await resourcesInBucket()).toEqual({});
    expect(await s3.text(bucket, LOCK)).toBe(JSON.stringify(holder));
  });
});
