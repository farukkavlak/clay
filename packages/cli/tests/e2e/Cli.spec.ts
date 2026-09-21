import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
// The tests compile to CommonJS, which has no import.meta.dirname.
// eslint-disable-next-line unicorn/prefer-module
const cliPackage = path.resolve(__dirname, '../..');
const clay = path.join(cliPackage, 'bin/clay.js');
const declaredVersion = async () => (JSON.parse(await fs.readFile(path.join(cliPackage, 'package.json'), 'utf8')) as { version: string }).version;

// These run the command the way a user does, in its own process, so the entry point is covered too.
// It runs what the build wrote, which is why the package builds before its tests.
describe('the clay command', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-cli-'));
    await fs.writeFile(path.join(dir, 'main.clay'), `resource "local_file" "a" { path = "${path.join(dir, 'a.txt')}" content = "hi" }`, 'utf8');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  // A guard against the version drifting back into the source, where it was typed by hand.
  it('prints the version the package declares', async () => {
    const { stdout } = await run('node', [clay, '--version'], { cwd: dir });

    expect(stdout.trim()).toBe(await declaredVersion());
  });

  // `true` reads nothing and closes the pipe at once, so the first line written hits a closed reader.
  it('says nothing about a reader that stops before it starts', async () => {
    const { stderr } = await run('sh', ['-c', `node ${clay} plan | true`], { cwd: dir });

    expect(stderr).toBe('');
  });
});
