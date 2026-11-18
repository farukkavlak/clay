import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clay, clayOutput } from '../helpers';

const FILE = 'resource "local_file" "f" {\n  path    = "f.txt"\n  content = "x"\n}\n';
const IGNORING = 'resource "local_file" "f" {\n  path    = "f.txt"\n  content = "x"\n  lifecycle {\n    ignore_changes = [content]\n  }\n}\n';

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

describe('plan --detailed-exitcode', () => {
  let dir: string;

  const write = (config: string) => fs.writeFile(path.join(dir, 'main.clay'), config, 'utf8');

  const plan = async (...args: string[]): Promise<Ran> => {
    try {
      const { stdout, stderr } = await promisify(execFile)('node', [clay, 'plan', ...args], { cwd: dir });
      return { code: 0, stdout: stripVTControlCharacters(stdout), stderr: stripVTControlCharacters(stderr) };
    } catch (error) {
      const failed = error as Ran;
      return { code: failed.code, stdout: stripVTControlCharacters(failed.stdout), stderr: stripVTControlCharacters(failed.stderr) };
    }
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-plan-exit-'));
    await write(FILE);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('exits 2 and shows the plan when a resource would change', async () => {
    const ran = await plan('--detailed-exitcode');

    expect(ran.code).toBe(2);
    expect(ran.stdout).toContain('Plan: 1 to add, 0 to change, 0 to destroy.');
    expect(ran.stderr).toBe('');
  });

  it('exits 0 when nothing would change', async () => {
    await clayOutput(dir, 'apply', '--yes');

    const ran = await plan('--detailed-exitcode');

    expect(ran.code).toBe(0);
    expect(ran.stdout).toContain('No changes.');
  });

  it('exits 0 with changes when the flag is not given', async () => {
    const ran = await plan();

    expect(ran.code).toBe(0);
    expect(ran.stdout).toContain('Plan: 1 to add');
  });

  it('exits 2 when only an output would change', async () => {
    await clayOutput(dir, 'apply', '--yes');
    await write(`${FILE}output "o" {\n  value = "new"\n}\n`);

    const ran = await plan('--detailed-exitcode');

    expect(ran.code).toBe(2);
    expect(ran.stdout).toContain('An apply would only update the outputs in state.');
  });

  it('exits 2 when only the state would take what changed outside Clay', async () => {
    await write(IGNORING);
    await clayOutput(dir, 'apply', '--yes');
    await fs.writeFile(path.join(dir, 'f.txt'), 'changed by hand', 'utf8');

    const ran = await plan('--detailed-exitcode');

    expect(ran.code).toBe(2);
    expect(ran.stdout).toContain('An apply would only update the state.');
  });

  it('exits 2 for a destroy with something to destroy', async () => {
    await clayOutput(dir, 'apply', '--yes');

    const ran = await plan('--destroy', '--detailed-exitcode');

    expect(ran.code).toBe(2);
    expect(ran.stdout).toContain('0 to add, 0 to change, 1 to destroy');
  });

  it('exits 0 for a destroy with nothing to destroy', async () => {
    const ran = await plan('--destroy', '--detailed-exitcode');

    expect(ran.code).toBe(0);
    expect(ran.stdout).toContain('The state holds nothing to destroy.');
  });

  it('exits 2 and still saves the plan', async () => {
    const ran = await plan('--detailed-exitcode', '--out', 'saved.json');

    expect(ran.code).toBe(2);
    await clayOutput(dir, 'apply', 'saved.json');
    await expect(fs.readFile(path.join(dir, 'f.txt'), 'utf8')).resolves.toBe('x');
  });

  it('exits 1 when the plan cannot be saved', async () => {
    await fs.mkdir(path.join(dir, 'saved'));

    const ran = await plan('--detailed-exitcode', '--out', 'saved');

    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain('Planning failed:');
  });

  it('exits 1 when the plan fails', async () => {
    await write('resource "local_file" "f" {\n  nope = "x"\n}\n');

    const ran = await plan('--detailed-exitcode');

    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain('Planning failed:');
  });
});
