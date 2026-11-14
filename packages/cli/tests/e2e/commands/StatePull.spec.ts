import { emptyState } from '@clay/contracts';
import { LocalBackend, parseState } from '@clay/state';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clay } from '../helpers';

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

const THREE = 'resource "null_resource" "a" {\n  count = 3\n}\n';

/** Kills clay with no chance to save once the three exist, so what they hold is only in the journal. */
const KILLED = `${THREE}resource "command_exec" "last" {\n  command = "kill -9 $PPID # \${null_resource.a[2].id}"\n}\n`;

describe('clay state pull', () => {
  let dir: string;

  const configure = (config: string) => fs.writeFile(path.join(dir, 'main.clay'), config, 'utf8');

  const run = async (...args: string[]): Promise<Ran> => {
    try {
      const { stdout, stderr } = await promisify(execFile)('node', [clay, ...args], { cwd: dir });
      return { code: 0, stdout, stderr };
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && typeof error.code === 'number')) throw error;

      const { code, stdout, stderr } = error as Error & Ran;
      return { code, stdout, stderr };
    }
  };

  beforeEach(async () => {
    // Real, as the CLI names it: the temp directory is a link on macOS.
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'clay-state-pull-')));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('prints the state an apply wrote, as the state file holds it', async () => {
    await configure(THREE);
    const applied = await run('apply', '-y');
    expect(applied.code).toBe(0);

    const pulled = await run('state', 'pull');

    expect(pulled.code).toBe(0);
    expect(pulled.stdout).toBe(`${await fs.readFile(path.join(dir, 'clay.state.json'), 'utf8')}\n`);
    expect(Object.keys(parseState(pulled.stdout, 'pulled').resources)).toEqual(['null_resource.a[0]', 'null_resource.a[1]', 'null_resource.a[2]']);
  });

  // A `cat` of the file would miss them.
  it('prints what the journal holds beside the state file', async () => {
    await configure(KILLED);
    await expect(run('apply', '-y')).rejects.toMatchObject({ signal: 'SIGKILL' });
    const file = JSON.parse(await fs.readFile(path.join(dir, 'clay.state.json'), 'utf8')) as { resources: object };
    expect(Object.keys(file.resources)).toEqual([]);

    const pulled = await run('state', 'pull');

    expect(pulled.code).toBe(0);
    expect(Object.keys(parseState(pulled.stdout, 'pulled').resources)).toEqual(['null_resource.a[0]', 'null_resource.a[1]', 'null_resource.a[2]']);
  });

  // A script can tell no state yet from a failure.
  it('prints nothing and exits 0 when there is no state, and says so on stderr', async () => {
    const pulled = await run('state', 'pull');

    expect(pulled).toEqual({ code: 0, stdout: '', stderr: `No state found at ${path.join(dir, 'clay.state.json')}\n` });
  });

  it('exits 1 with nothing on stdout when the state cannot be read', async () => {
    await fs.writeFile(path.join(dir, 'clay.state.json'), '{', 'utf8');

    const pulled = await run('state', 'pull');

    expect(pulled.code).toBe(1);
    expect(pulled.stdout).toBe('');
    expect(pulled.stderr).toContain('Error reading state:');
  });

  // A backup that hid a value could not be put back.
  it('prints a sensitive value as it is, and a control character in a value escaped', async () => {
    const content = 'secret\u009B2J';
    const resource = { resourceType: 'null_resource', name: 'a', attributes: { content }, sensitive: [['content']] };
    await new LocalBackend(dir).write({ ...emptyState(), resources: { 'null_resource.a': resource } });

    const pulled = await run('state', 'pull');

    expect(pulled.code).toBe(0);
    expect(pulled.stdout).toContain(String.raw`"content": "secret\u009b2J"`);
    expect(pulled.stdout).not.toContain('\u009B');
    expect(parseState(pulled.stdout, 'pulled').resources['null_resource.a']).toEqual(resource);
  });
});
