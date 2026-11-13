import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HttpStateServer } from '../../../../../tests/httpStateServer';
import { clay, clayOutput } from '../helpers';

const FILE = 'resource "local_file" "f" {\n  path    = "f.txt"\n  content = "x"\n}\n';
const gone = { id: 'left-by-a-dead-run', operation: 'apply', who: 'someone', host: 'elsewhere', pid: 4242, created: '2026-11-13T10:00:00.000Z' };

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

describe('clay force-unlock', () => {
  let dir: string;

  const lockPath = () => path.join(dir, 'clay.state.json.lock');
  const run = async (...args: string[]): Promise<Ran> => {
    try {
      const { stdout, stderr } = await promisify(execFile)('node', [clay, ...args], { cwd: dir });
      return { code: 0, stdout: stripVTControlCharacters(stdout), stderr: stripVTControlCharacters(stderr) };
    } catch (error) {
      const failed = error as Ran;
      return { code: failed.code, stdout: stripVTControlCharacters(failed.stdout), stderr: stripVTControlCharacters(failed.stderr) };
    }
  };

  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'clay-force-unlock-')));
    await fs.writeFile(path.join(dir, 'main.clay'), FILE, 'utf8');
    await clayOutput(dir, 'init');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('releases the lock a refused plan names, so the next plan runs', async () => {
    await fs.writeFile(lockPath(), JSON.stringify(gone));
    const refused = await run('plan');
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(`If that run is gone, run clay force-unlock ${gone.id}`);

    const released = await run('force-unlock', gone.id);

    expect(released).toEqual({ code: 0, stdout: `Released lock ${gone.id} on ${path.join(dir, 'clay.state.json')}\n`, stderr: '' });
    await expect(fs.access(lockPath())).rejects.toThrow(/ENOENT/);
    const next = await run('plan');
    expect(next.code).toBe(0);
  });

  it('leaves a lock with another id in place and exits 1', async () => {
    await fs.writeFile(lockPath(), JSON.stringify(gone));

    const ran = await run('force-unlock', 'another');

    expect(ran.code).toBe(1);
    expect(ran.stderr.trim()).toBe(`Error releasing the lock: ${lockPath()} holds lock ${gone.id}, not another, so it is left in place`);
    expect(JSON.parse(await fs.readFile(lockPath(), 'utf8'))).toEqual(gone);
  });

  it('says no lock is held where none is and exits 1', async () => {
    const ran = await run('force-unlock', gone.id);

    expect(ran.code).toBe(1);
    expect(ran.stderr.trim()).toBe(`Error releasing the lock: No lock is held at ${lockPath()}`);
  });

  it('refuses a run with no id', async () => {
    const ran = await run('force-unlock');

    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain("missing required argument 'id'");
  });

  describe('on an HTTP server', () => {
    let server: HttpStateServer;

    beforeEach(async () => {
      server = await HttpStateServer.start();
      const backend = `clay {\n  backend "http" {\n    address      = "${server.url}/state"\n    lock_address = "${server.url}/lock"\n    retry_max    = 0\n  }\n}\n`;
      await fs.writeFile(path.join(dir, 'main.clay'), backend + FILE, 'utf8');
      await clayOutput(dir, 'init', '--yes');
    });

    afterEach(async () => {
      await server.stop();
    });

    it('releases the lock the server names', async () => {
      server.lock = JSON.stringify(gone);

      const ran = await run('force-unlock', gone.id);

      expect(ran).toEqual({ code: 0, stdout: `Released lock ${gone.id} on ${server.url}/state\n`, stderr: '' });
      expect(server.lock).toBeUndefined();
    });
  });
});
