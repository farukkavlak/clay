import { newLockInfo } from '@clay/state';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AzureStateServer } from '../../../../../tests/azureStateServer';
import { clay } from '../helpers';

const FILE = 'resource "local_file" "f" {\n  path    = "f.txt"\n  content = "x"\n}\n';

/** No credentials of the machine the tests run on reach the CLI. */
const AZURE_UNSET = { AZURE_STORAGE_KEY: '', AZURE_STORAGE_SAS_TOKEN: '' };
const CREDENTIALS = { AZURE_STORAGE_KEY: Buffer.from('test-key').toString('base64') };

describe('a state kept in Azure Blob storage', () => {
  let dir: string;
  let server: AzureStateServer;

  /** What the CLI printed and exited with, run with `env` over the test's Azure settings. */
  const run = async (env: Record<string, string>, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    try {
      const { stdout, stderr } = await promisify(execFile)('node', [clay, ...args], { cwd: dir, env: { ...process.env, ...AZURE_UNSET, ...env } });
      return { code: 0, stdout: stripVTControlCharacters(stdout), stderr: stripVTControlCharacters(stderr) };
    } catch (error) {
      const failed = error as { code: number; stdout: string; stderr: string };
      return { code: failed.code, stdout: stripVTControlCharacters(failed.stdout), stderr: stripVTControlCharacters(failed.stderr) };
    }
  };
  const clayWith = (...args: string[]) => run(CREDENTIALS, ...args);

  const configure = () =>
    fs.writeFile(
      path.join(dir, 'main.clay'),
      `clay {\n  backend "azure" {\n    storage_account_name = "${server.account}"\n    container_name       = "state"\n    key                  = "env/state.json"\n    endpoint             = "${server.url}"\n  }\n}\n${FILE}`,
      'utf8'
    );

  const stateInContainer = () => JSON.parse(server.text('state/env/state.json')!) as { serial: number; resources: Record<string, unknown> };
  const exists = (name: string) =>
    fs.access(path.join(dir, name)).then(
      () => true,
      () => false
    );

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-azure-backend-'));
    server = await AzureStateServer.start();
    await configure();
  });

  afterEach(async () => {
    await server.stop();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('is started in the container by init, and nothing in the workspace', async () => {
    const { code, stdout } = await clayWith('init');

    expect(code).toBe(0);
    expect(stdout).toContain('Created an empty state');
    expect(stateInContainer()).toMatchObject({ serial: 0, resources: {} });
    expect(server.text('state/env/state.json.lock')).toBeUndefined();
    expect(await exists('clay.state.json')).toBe(false);
    expect(JSON.parse(await fs.readFile(path.join(dir, '.clay', 'backend.json'), 'utf8'))).toEqual({
      type: 'azure',
      settings: { storage_account_name: server.account, container_name: 'state', key: 'env/state.json', endpoint: server.url },
    });
  });

  it('is written by apply under the lock it takes, and the lock released', async () => {
    await clayWith('init');
    server.received.length = 0;

    const { code, stdout } = await clayWith('apply', '--yes');

    expect(code).toBe(0);
    expect(stdout).toContain('Apply complete! Resources: 1 added');
    expect(Object.keys(stateInContainer().resources)).toEqual(['local_file.f']);
    expect(server.received[0]).toMatchObject({ method: 'PUT', path: '/state/env/state.json.lock', ifNoneMatch: '*', signed: 'key' });
    expect(server.received.at(-1)).toMatchObject({ method: 'DELETE', path: '/state/env/state.json.lock', ifMatch: expect.stringMatching(/^"0x[0-9A-F]{15}"$/) });
    expect(server.text('state/env/state.json.lock')).toBeUndefined();
    expect(await exists('clay.state.json')).toBe(false);
  });

  it('refuses a run while another holds the lock, naming how to free it, and writes nothing', async () => {
    await clayWith('init');
    const holder = { ...newLockInfo('apply'), host: 'elsewhere' };
    server.put('state/env/state.json.lock', JSON.stringify(holder));

    const { code, stderr } = await clayWith('apply', '--yes');

    expect(code).toBe(1);
    expect(stderr).toContain(`State is locked by apply of ${holder.who} on elsewhere, pid ${holder.pid}`);
    expect(stderr).toContain(`delete ${server.url}/state/env/state.json.lock`);
    expect(stateInContainer().resources).toEqual({});
    expect(server.text('state/env/state.json.lock')).toBe(JSON.stringify(holder));
    expect(await exists('f.txt')).toBe(false);
  });

  it('sends a SAS token given with its "?", as the portal copies it', async () => {
    const { code } = await run({ AZURE_STORAGE_SAS_TOKEN: '?sv=2024-11-04&sp=rcwd&sig=c2ln' }, 'init');

    expect(code).toBe(0);
    expect(server.received.length).toBeGreaterThan(0);
    expect(server.received.map(({ signed }) => signed)).toEqual(server.received.map(() => 'sas'));
  });

  it('is refused where no credentials are found, naming where to give them', async () => {
    const { code, stderr } = await run({}, 'init');

    expect(code).toBe(1);
    expect(stderr).toContain('found no Azure credentials; give them in AZURE_STORAGE_KEY or AZURE_STORAGE_SAS_TOKEN');
    expect(server.received).toEqual([]);
    expect(await exists('.clay')).toBe(false);
  });

  it('is refused where Azure refuses the credentials, naming what it answered', async () => {
    server.override('GET /state/env/state.json', { status: 403, code: 'AuthenticationFailed' });

    const { code, stderr } = await clayWith('init');

    expect(code).toBe(1);
    expect(stderr).toContain(`GetBlob ${server.url}/state/env/state.json answered 403 AuthenticationFailed`);
    expect(await exists('.clay')).toBe(false);
  });

  it('takes a local state into the container with init --yes', async () => {
    await fs.writeFile(path.join(dir, 'main.clay'), FILE, 'utf8');
    await clayWith('init');
    await clayWith('apply', '--yes');
    await configure();

    const { code, stdout } = await clayWith('init', '--yes');

    expect(code).toBe(0);
    expect(stdout).toContain(`Moved the state in "clay.state.json" to "${server.url}/state/env/state.json"`);
    expect(Object.keys(stateInContainer().resources)).toEqual(['local_file.f']);
    expect(server.text('state/env/state.json.lock')).toBeUndefined();
    const plan = await clayWith('plan');
    expect(plan.stdout).toContain('No changes');
  });
});
