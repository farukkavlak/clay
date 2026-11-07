import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HttpStateServer } from '../../../../../tests/httpStateServer';
import { clay, clayOutput } from '../helpers';

const FILE = 'resource "local_file" "f" {\n  path    = "f.txt"\n  content = "x"\n}\n';

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

describe('a command whose work is done but whose lock is not released', () => {
  let dir: string;
  let server: HttpStateServer;

  const run = async (...args: string[]): Promise<Ran> => {
    try {
      const { stdout, stderr } = await promisify(execFile)('node', [clay, ...args], { cwd: dir });
      return { code: 0, stdout: stripVTControlCharacters(stdout), stderr: stripVTControlCharacters(stderr) };
    } catch (error) {
      const failed = error as Ran;
      return { code: failed.code, stdout: stripVTControlCharacters(failed.stdout), stderr: stripVTControlCharacters(failed.stderr) };
    }
  };

  const failUnlock = () => server.override('UNLOCK /lock', { status: 500 });
  const lockLeft = () => `The lock could not be released: UNLOCK ${server.url}/lock answered 500`;
  const resourcesOnServer = () => Object.keys((JSON.parse(server.state!) as { resources: Record<string, unknown> }).resources);

  /** Exit 1 and the lock named after what the work printed, with no word that the work failed. */
  const expectLockLeftAfter = (ran: Ran, done: string) => {
    expect(ran.stdout).toContain(done);
    expect(ran.stderr.trim()).toBe(lockLeft());
    expect(ran.code).toBe(1);
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-lock-left-'));
    server = await HttpStateServer.start();
    const backend = `clay {\n  backend "http" {\n    address      = "${server.url}/state"\n    lock_address = "${server.url}/lock"\n    retry_max    = 0\n  }\n}\n`;
    await fs.writeFile(path.join(dir, 'main.clay'), backend + FILE, 'utf8');
  });

  afterEach(async () => {
    await server.stop();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('init says the state was made', async () => {
    failUnlock();

    expectLockLeftAfter(await run('init'), 'Clay initialized successfully');
    expect(resourcesOnServer()).toEqual([]);
  });

  it('plan shows the plan and saves it', async () => {
    await clayOutput(dir, 'init');
    failUnlock();

    expectLockLeftAfter(await run('plan', '--out', 'saved.json'), 'Plan: 1 to add, 0 to change, 0 to destroy.');
    await expect(fs.access(path.join(dir, 'saved.json'))).resolves.toBeUndefined();
  });

  it('apply says what it applied', async () => {
    await clayOutput(dir, 'init');
    failUnlock();

    expectLockLeftAfter(await run('apply', '--yes'), 'Apply complete! Resources: 1 added');
    expect(resourcesOnServer()).toEqual(['local_file.f']);
  });

  it('apply of a saved plan says what it applied', async () => {
    await clayOutput(dir, 'init');
    await clayOutput(dir, 'plan', '--out', 'saved.json');
    failUnlock();

    expectLockLeftAfter(await run('apply', 'saved.json'), 'Apply complete! Resources: 1 added');
    expect(resourcesOnServer()).toEqual(['local_file.f']);
  });

  it('state mv says it moved the resource', async () => {
    await clayOutput(dir, 'init');
    await clayOutput(dir, 'apply', '--yes');
    failUnlock();

    expectLockLeftAfter(await run('state', 'mv', 'local_file.f', 'local_file.g'), 'Successfully moved resource.');
    expect(resourcesOnServer()).toEqual(['local_file.g']);
  });

  it('state rm says it removed the resource', async () => {
    await clayOutput(dir, 'init');
    await clayOutput(dir, 'apply', '--yes');
    failUnlock();

    expectLockLeftAfter(await run('state', 'rm', 'local_file.f'), 'Successfully removed resource.');
    expect(resourcesOnServer()).toEqual([]);
  });

  it('a command whose work failed says so, beside the lock it left', async () => {
    await clayOutput(dir, 'init');
    failUnlock();

    const ran = await run('state', 'mv', 'local_file.f', 'local_file.g');

    expect(ran.stderr.trim()).toBe(`Error moving resource: Source resource not found: local_file.f\n\nUNLOCK ${server.url}/lock answered 500`);
    expect(ran.code).toBe(1);
  });
});
