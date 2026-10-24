import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const cliPackage = path.resolve(__dirname, '../..');
const clay = path.join(cliPackage, 'bin/clay.js');
const declaredVersion = async () => (JSON.parse(await fs.readFile(path.join(cliPackage, 'package.json'), 'utf8')) as { version: string }).version;

// Runs the built command in its own process, so the entry point is covered too.
// That is why the package builds before its tests.
describe('the clay command', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-cli-'));
    await fs.writeFile(path.join(dir, 'main.clay'), `resource "local_file" "a" { path = "${path.join(dir, 'a.txt')}" content = "hi" }`, 'utf8');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  // Guards against the version being typed into the source again.
  it('prints the version the package declares', async () => {
    const { stdout } = await run('node', [clay, '--version'], { cwd: dir });

    expect(stdout.trim()).toBe(await declaredVersion());
  });

  const failed = async (command: string) => {
    try {
      await run('sh', ['-c', command], { cwd: dir });
    } catch (error) {
      return error as { code: number; stderr: string };
    }
    throw new Error(`${command} exited 0`);
  };

  it('exits 1 and applies nothing when the answer is not yes', async () => {
    const { code, stderr } = await failed(`echo no | node ${clay} apply`);

    expect(code).toBe(1);
    expect(stderr).toContain('Apply cancelled.');
    await expect(fs.access(path.join(dir, 'a.txt'))).rejects.toThrow();
  });

  it('exits 1 and names --yes when the input is closed before an answer', async () => {
    const { code, stderr } = await failed(`node ${clay} apply < /dev/null`);

    expect(code).toBe(1);
    expect(stderr).toContain('No answer: the input is closed. Run with --yes to approve without asking');
    await expect(fs.access(path.join(dir, 'a.txt'))).rejects.toThrow();
  });

  // `true` closes the pipe at once, so the first write hits a closed reader.
  it('says nothing about a reader that stops before it starts', async () => {
    const { stderr } = await run('sh', ['-c', `node ${clay} plan | true`], { cwd: dir });

    expect(stderr).toBe('');
  });

  it('prints an empty JSON object for output --json before any state exists', async () => {
    const { stdout } = await run('node', [clay, 'output', '--json'], { cwd: dir });

    expect(JSON.parse(stdout)).toEqual({});
  });
});
