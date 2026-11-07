import { ChildProcess, execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify, stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clay } from '../helpers';

interface Ended {
  code: number | null;
  stdout: string;
  stderr: string;
}

const holder = { id: 'held-by-another-run', operation: 'state rm', who: 'someone', host: 'elsewhere', pid: 4242, created: '2026-11-07T10:00:00.000Z' };
const HELD = 'State is locked by state rm of someone on elsewhere, pid 4242, since 2026-11-07T10:00:00.000Z';

describe('a command that waits for the lock', () => {
  let dir: string;
  let waiting: ChildProcess | undefined;

  const file = (name: string) => path.join(dir, name);
  const leaveLock = (at = 'clay.state.json.lock') => fs.writeFile(file(at), JSON.stringify(holder));
  const lockHeld = async (at = 'clay.state.json.lock') => JSON.parse(await fs.readFile(file(at), 'utf8')) as unknown;
  const exists = (name: string) =>
    fs.access(file(name)).then(
      () => true,
      () => false
    );

  /** Starts a command and returns once it says it waits for the lock. */
  const waitingFor = async (...args: string[]): Promise<{ ended: Promise<Ended> }> => {
    const child = spawn('node', [clay, ...args], { cwd: dir });
    waiting = child;
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const ended = once(child, 'exit').then(([code]) => ({ code: code as number | null, stdout: stripVTControlCharacters(stdout), stderr: stripVTControlCharacters(stderr) }));

    while (!stderr.includes('for it to be released...')) {
      if (child.exitCode !== null) throw new Error(`Exited without waiting: ${stderr}`);
      await sleep(20);
    }
    return { ended };
  };

  const run = async (...args: string[]): Promise<Ended> => {
    try {
      const { stdout, stderr } = await promisify(execFile)('node', [clay, ...args], { cwd: dir });
      return { code: 0, stdout: stripVTControlCharacters(stdout), stderr: stripVTControlCharacters(stderr) };
    } catch (error) {
      const failed = error as { code: number; stdout: string; stderr: string };
      return { code: failed.code, stdout: stripVTControlCharacters(failed.stdout), stderr: stripVTControlCharacters(failed.stderr) };
    }
  };

  beforeEach(async () => {
    // The CLI names the lock under the path the directory resolves to.
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'clay-lock-timeout-')));
    await promisify(execFile)('node', [clay, 'init'], { cwd: dir });
    await fs.writeFile(file('main.clay'), 'output "o" {\n  value = 1\n}\n', 'utf8');
  });

  afterEach(async () => {
    waiting?.kill('SIGKILL');
    waiting = undefined;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it.each([[[]], [['--lock-timeout', '0']]])('is refused at once with %j, as before', async (flags) => {
    await leaveLock();

    const { code, stderr } = await run('plan', ...flags);

    expect(code).toBe(1);
    expect(stderr).toContain(HELD);
    expect(stderr).not.toContain('Waiting');
  });

  it.each([
    [['plan'], 'Changes to outputs:'],
    [['apply', '--yes'], 'Apply complete!'],
    [['init'], 'Kept the state already here'],
    [['state', 'mv', 'a.b', 'a.c'], 'Source resource not found: a.b'],
    [['state', 'rm', 'a.b'], 'Resource not found in state: a.b'],
  ])('%j takes the lock once it is let go', async (args, done) => {
    await leaveLock();

    const { ended } = await waitingFor(...args, '--lock-timeout', '30');
    await fs.rm(file('clay.state.json.lock'));

    const { stdout, stderr } = await ended;
    expect(stderr).toContain(`${HELD}. If that run is gone, remove ${file('clay.state.json.lock')}\nWaiting up to 30s for it to be released...`);
    expect(stdout + stderr).toContain(done);
    expect(await exists('clay.state.json.lock')).toBe(false);
  });

  it('applies a saved plan once the lock is let go', async () => {
    await run('plan', '--out', 'saved.plan');
    await leaveLock();

    const { ended } = await waitingFor('apply', 'saved.plan', '--lock-timeout', '30');
    await fs.rm(file('clay.state.json.lock'));

    const { stdout } = await ended;
    expect(stdout).toContain('Apply complete!');
  });

  it('gives up when the time is gone, saying how long it waited', async () => {
    await leaveLock();

    const { code, stderr } = await run('plan', '--lock-timeout', '1');

    expect(code).toBe(1);
    expect(stderr).toContain(`Waited 1s for the lock. ${HELD}`);
    expect(await lockHeld()).toEqual(holder);
  });

  it.each([['plan'], ['apply', '--yes'], ['init'], ['state', 'rm', 'a.b']])('%j stops waiting at once on Ctrl-C, and leaves the lock it waited for', async (...args) => {
    await leaveLock();
    const { ended } = await waitingFor(...args, '--lock-timeout', '60');

    waiting!.kill('SIGINT');

    const { code, stderr } = await ended;
    expect(code).toBe(130);
    expect(stderr).toContain('Interrupted. Nothing was written.');
    expect(await lockHeld()).toEqual(holder);
  });

  it('init waits for the lock of the place the state moves from, and Ctrl-C there releases the new one', async () => {
    await fs.writeFile(file('main.clay'), 'clay {\n  backend "local" {\n    path = "new.json"\n  }\n}\n', 'utf8');
    await leaveLock();
    const { ended } = await waitingFor('init', '--yes', '--lock-timeout', '60');
    expect(await exists('new.json.lock')).toBe(true);

    waiting!.kill('SIGINT');

    const { code } = await ended;
    expect(code).toBe(130);
    expect(await exists('new.json.lock')).toBe(false);
    expect(await lockHeld()).toEqual(holder);
  });

  it.each([['-1'], ['1.5'], ['3601'], ['01'], ['ten']])('refuses --lock-timeout %s', async (value) => {
    const { code, stderr } = await run('plan', '--lock-timeout', value);

    expect(code).toBe(1);
    expect(stderr).toContain(`option '--lock-timeout <seconds>' argument '${value}' is invalid. --lock-timeout is a whole number of seconds from 0 to 3600`);
  });
});
