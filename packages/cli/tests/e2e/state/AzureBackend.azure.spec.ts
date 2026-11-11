import { newLockInfo } from '@clay/state';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { RealAzure } from '../../../../../tests/realAzure';
import { clay } from '../helpers';

const FILE = 'resource "local_file" "f" {\n  path    = "f.txt"\n  content = "x"\n}\n';
const KEY = 'env/state.json';
const LOCK = `${KEY}.lock`;

describe('a state kept on a real Azure Blob server', () => {
  let azure: RealAzure;
  let container = '';
  let dir: string;

  /** What the CLI printed and exited with; only the test's account key reaches it. */
  const clayWith = async (...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    const env = { ...process.env, AZURE_STORAGE_KEY: azure.accountKey, AZURE_STORAGE_SAS_TOKEN: '' };
    try {
      const { stdout, stderr } = await promisify(execFile)('node', [clay, ...args], { cwd: dir, env });
      return { code: 0, stdout: stripVTControlCharacters(stdout), stderr: stripVTControlCharacters(stderr) };
    } catch (error) {
      const failed = error as { code: number; stdout: string; stderr: string };
      return { code: failed.code, stdout: stripVTControlCharacters(failed.stdout), stderr: stripVTControlCharacters(failed.stderr) };
    }
  };

  const resourcesInContainer = async () => {
    const state = JSON.parse((await azure.text(container, KEY))!) as { resources: Record<string, unknown> };
    return state.resources;
  };

  beforeAll(() => {
    azure = RealAzure.fromEnv();
  });

  beforeEach(async () => {
    container = '';
    container = await azure.newContainer();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-azure-server-'));
    const backend = `  backend "azure" {\n    storage_account_name = "${azure.account}"\n    container_name       = "${container}"\n    key                  = "${KEY}"\n    endpoint             = "${azure.endpoint}"\n  }\n`;
    await fs.writeFile(path.join(dir, 'main.clay'), `clay {\n${backend}}\n${FILE}`, 'utf8');
  });

  afterEach(async () => {
    if (container !== '') await azure.removeContainer(container);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('is started by init, written by apply, and the lock released', async () => {
    const init = await clayWith('init');
    expect(init.code).toBe(0);

    const { code, stdout } = await clayWith('apply', '--yes');

    expect(code).toBe(0);
    expect(stdout).toContain('Apply complete! Resources: 1 added');
    expect(Object.keys(await resourcesInContainer())).toEqual(['local_file.f']);
    expect(await azure.text(container, LOCK)).toBeUndefined();
    const plan = await clayWith('plan');
    expect(plan.stdout).toContain('No changes');
  });

  it('refuses a run while another holds the lock, and writes nothing', async () => {
    await clayWith('init');
    const holder = { ...newLockInfo('apply'), host: 'elsewhere' };
    await azure.put(container, LOCK, JSON.stringify(holder));

    const { code, stderr } = await clayWith('apply', '--yes');

    expect(code).toBe(1);
    expect(stderr).toContain(`State is locked by apply of ${holder.who} on elsewhere, pid ${holder.pid}`);
    expect(await resourcesInContainer()).toEqual({});
    expect(await azure.text(container, LOCK)).toBe(JSON.stringify(holder));
  });
});
