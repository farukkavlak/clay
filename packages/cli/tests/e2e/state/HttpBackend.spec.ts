import { newLockInfo } from '@clay/state';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HttpStateServer } from '../../../../../tests/httpStateServer';
import { clay, clayOutput } from '../helpers';

const FILE = 'resource "local_file" "f" {\n  path    = "f.txt"\n  content = "x"\n}\n';

describe('a state kept on an HTTP server', () => {
  let dir: string;
  let server: HttpStateServer;

  const refusal = async (...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    try {
      await promisify(execFile)('node', [clay, ...args], { cwd: dir });
    } catch (error) {
      const failed = error as { code: number; stdout: string; stderr: string };
      return { code: failed.code, stdout: stripVTControlCharacters(failed.stdout), stderr: stripVTControlCharacters(failed.stderr) };
    }

    throw new Error('Expected the command to fail');
  };

  const configure = (url: string) =>
    fs.writeFile(path.join(dir, 'main.clay'), `clay {\n  backend "http" {\n    address      = "${url}/state"\n    lock_address = "${url}/lock"\n  }\n}\n${FILE}`, 'utf8');

  const stateOnServer = () => JSON.parse(server.state!) as { serial: number; resources: Record<string, unknown> };
  const exists = (name: string) =>
    fs.access(path.join(dir, name)).then(
      () => true,
      () => false
    );

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-http-backend-'));
    server = await HttpStateServer.start();
    await configure(server.url);
  });

  afterEach(async () => {
    await server.stop();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('is started on the server by init, and nothing in the workspace', async () => {
    expect(await clayOutput(dir, 'init')).toContain('Created an empty state');

    expect(stateOnServer()).toMatchObject({ serial: 0, resources: {} });
    expect(await exists('clay.state.json')).toBe(false);
    expect(JSON.parse(await fs.readFile(path.join(dir, '.clay', 'backend.json'), 'utf8'))).toEqual({
      type: 'http',
      settings: {
        address: `${server.url}/state`,
        update_method: 'POST',
        lock_address: `${server.url}/lock`,
        lock_method: 'LOCK',
        unlock_address: `${server.url}/lock`,
        unlock_method: 'UNLOCK',
      },
    });
  });

  it('is written by apply under the lock it takes, and the lock released', async () => {
    await clayOutput(dir, 'init');
    server.received.length = 0;

    expect(await clayOutput(dir, 'apply', '--yes')).toContain('Apply complete! Resources: 1 added');

    expect(Object.keys(stateOnServer().resources)).toEqual(['local_file.f']);
    expect(server.lock).toBeUndefined();
    const lockId = (JSON.parse(server.received[0].body) as { id: string }).id;
    const writes = server.received.filter(({ method }) => method === 'POST');
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.map(({ id }) => id)).toEqual(writes.map(() => lockId));
    expect(server.received.at(-1)?.method).toBe('UNLOCK');
    expect(await exists('clay.state.json')).toBe(false);
  });

  it('is run on again once init takes a lock address the configuration changed, with the state left on the server', async () => {
    await clayOutput(dir, 'init');
    await clayOutput(dir, 'apply', '--yes');
    const config = path.join(dir, 'main.clay');
    const written = await fs.readFile(config, 'utf8');
    await fs.writeFile(config, written.replace(`${server.url}/lock`, `${server.url}/lock?team=a`), 'utf8');

    const refused = await refusal('plan');
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(
      `lock_address of backend "http" is "${server.url}/lock?team=a" in the configuration, and "${server.url}/lock" where \`clay init\` took it; run \`clay init\``
    );

    expect(await clayOutput(dir, 'init')).toContain('Kept the state already here');
    expect(await clayOutput(dir, 'plan')).toContain('No changes');
  });

  it('is named by its address where the server holds none', async () => {
    await clayOutput(dir, 'init');
    server.state = undefined;

    expect(await clayOutput(dir, 'state', 'list')).toContain(`No state found at ${server.url}/state`);
  });

  it('is read by plan and the state commands', async () => {
    await clayOutput(dir, 'init');
    await clayOutput(dir, 'apply', '--yes');

    expect(await clayOutput(dir, 'plan')).toContain('No changes');
    expect(await clayOutput(dir, 'state', 'list')).toContain('local_file.f');
  });

  it('refuses a run while another holds the lock on the server, and writes nothing', async () => {
    await clayOutput(dir, 'init');
    const holder = { ...newLockInfo('apply'), host: 'elsewhere' };
    server.lock = JSON.stringify(holder);

    const { code, stderr } = await refusal('apply', '--yes');

    expect(code).toBe(1);
    expect(stderr).toContain(`State is locked by apply of ${holder.who} on elsewhere, pid ${holder.pid}`);
    expect(stderr).toContain(`send UNLOCK to ${server.url}/lock with what the lock holds`);
    expect(stateOnServer().resources).toEqual({});
    expect(server.lock).toBe(JSON.stringify(holder));
    expect(await exists('f.txt')).toBe(false);
  });

  it('is refused by init where the server does not answer', async () => {
    const gone = await HttpStateServer.start();
    const url = gone.url;
    await configure(url);
    await gone.stop();

    const { code, stderr } = await refusal('init');

    expect(code).toBe(1);
    expect(stderr).toContain(`GET ${url}/state got no answer (ECONNREFUSED)`);
    expect(await exists('.clay')).toBe(false);
  });

  it('takes a local state to the server with init --yes', async () => {
    await fs.writeFile(path.join(dir, 'main.clay'), FILE, 'utf8');
    await clayOutput(dir, 'init');
    await clayOutput(dir, 'apply', '--yes');
    await configure(server.url);

    const stdout = await clayOutput(dir, 'init', '--yes');

    expect(stdout).toContain(`Moved the state in "clay.state.json" to "${server.url}/state"`);
    expect(Object.keys(stateOnServer().resources)).toEqual(['local_file.f']);
    expect(server.lock).toBeUndefined();
    expect(await exists('clay.state.json')).toBe(true);
    expect(await exists('clay.state.json.lock')).toBe(false);
    expect(await clayOutput(dir, 'plan')).toContain('No changes');
  });

  it('moves the state off the server, and exits 1 naming the lock it could not release there', async () => {
    await configure(server.url);
    await clayOutput(dir, 'init');
    await clayOutput(dir, 'apply', '--yes');
    await fs.writeFile(path.join(dir, 'main.clay'), FILE, 'utf8');
    server.override('UNLOCK /lock', { status: 500 });

    const { code, stdout, stderr } = await refusal('init', '--yes');

    expect(code).toBe(1);
    expect(stdout).toContain(`Moved the state in "${server.url}/state" to "clay.state.json"`);
    expect(stderr).toContain(`The lock could not be released: UNLOCK ${server.url}/lock`);
    expect(await clayOutput(dir, 'state', 'list')).toBe('local_file.f\n');
  });
});
