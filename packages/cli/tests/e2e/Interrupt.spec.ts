import { State } from '@clay/contracts';
import { ChildProcess, execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify, stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// The tests compile to CommonJS, which has no import.meta.dirname.
// eslint-disable-next-line unicorn/prefer-module
const clay = path.resolve(__dirname, '../../bin/clay.js');

// `after` reads `slow`, so it runs in the layer after it.
const config = `resource "command_exec" "slow" {
  command = "touch started.txt; sleep 2; touch made.txt"
}

resource "command_exec" "after" {
  command = "touch after.txt # \${command_exec.slow.id}"
}
`;

interface Ended {
  code: number | null;
  stderr: string;
}

describe('an interrupted apply', () => {
  let dir: string;

  const file = (name: string) => path.join(dir, name);

  const exists = (name: string) =>
    fs.access(file(name)).then(
      () => true,
      () => false
    );

  const held = async () => Object.keys((JSON.parse(await fs.readFile(file('clay.state.json'), 'utf8')) as State).resources);

  let group: number | undefined;

  /** Sent once `slow` runs, to the Clay process alone or, as a terminal's Ctrl-C does, to its whole process group. */
  const interrupted = async (times: number, toGroup = false): Promise<Ended> => {
    const child: ChildProcess = spawn('node', [clay, 'apply', '--yes'], { cwd: dir, detached: true });
    group = child.pid;
    let stderr = '';
    child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.stdout!.resume();
    const exited = once(child, 'exit');

    while (!(await exists('started.txt'))) await sleep(20);

    for (let sent = 0; sent < times; sent++) {
      if (toGroup) process.kill(-child.pid!, 'SIGINT');
      else child.kill('SIGINT');
      await sleep(100);
    }

    const [code] = (await exited) as [number | null];
    return { code, stderr: stripVTControlCharacters(stderr) };
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-interrupt-'));
    await promisify(execFile)('node', [clay, 'init'], { cwd: dir });
    await fs.writeFile(file('main.clay'), config, 'utf8');
  });

  afterEach(async () => {
    // A second interrupt leaves the command running.
    try {
      process.kill(-group!, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('lets what runs finish, records it, starts nothing more and unlocks', async () => {
    const { code, stderr } = await interrupted(1);

    expect(code).toBe(130);
    expect(stderr).toContain('Apply interrupted');
    expect(await exists('made.txt')).toBe(true);
    expect(await exists('after.txt')).toBe(false);
    expect(await held()).toEqual(['command_exec.slow']);
    expect(await exists('clay.state.json.lock')).toBe(false);
  });

  it('plans only what the interrupt left', async () => {
    await interrupted(1);

    const { stdout } = await promisify(execFile)('node', [clay, 'plan'], { cwd: dir });

    expect(stripVTControlCharacters(stdout)).toContain('1 to add, 0 to change, 0 to destroy');
  });

  it('exits at once on a second interrupt and says the lock is left', async () => {
    const { code, stderr } = await interrupted(2);

    expect(code).toBe(130);
    expect(stderr).toContain('Exiting now');
    expect(await exists('made.txt')).toBe(false);
    expect(await exists('clay.state.json.lock')).toBe(true);
  });

  it('reports the command a terminal Ctrl-C stops as failed, and unlocks', async () => {
    const { code, stderr } = await interrupted(1, true);

    expect(code).toBe(130);
    expect(stderr).toContain('Failed: command_exec.slow');
    expect(await exists('made.txt')).toBe(false);
    expect(await held()).toEqual([]);
    expect(await exists('clay.state.json.lock')).toBe(false);
  });
});
