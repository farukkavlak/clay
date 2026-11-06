import { ChildProcess, execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify, stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clay } from '../helpers';

// Reading a named pipe waits until something writes to it, so the plan holds the lock until the test lets it go on.
const config = `data "local_file" "gate" {
  path = "gate"
}

output "read" {
  value = data.local_file.gate.content
}
`;

interface Ended {
  code: number | null;
  stdout: string;
  stderr: string;
}

describe('a plan and the state lock', () => {
  let dir: string;
  let waiting: ChildProcess | undefined;

  const file = (name: string) => path.join(dir, name);
  const lockFile = () => file('clay.state.json.lock');

  const exists = (name: string) =>
    fs.access(file(name)).then(
      () => true,
      () => false
    );

  /** Starts a command that stops at the gate, and returns once it holds the lock. */
  const atTheGate = async (...args: string[]): Promise<{ ended: Promise<Ended>; stderr: () => string }> => {
    const child = spawn('node', [clay, ...args], { cwd: dir });
    waiting = child;
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const ended = once(child, 'exit').then(([code]) => ({ code: code as number | null, stdout: stripVTControlCharacters(stdout), stderr: stripVTControlCharacters(stderr) }));

    while (!(await exists('clay.state.json.lock'))) await sleep(20);

    return { ended, stderr: () => stderr };
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
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-plan-lock-'));
    await promisify(execFile)('node', [clay, 'init'], { cwd: dir });
    await fs.writeFile(file('main.clay'), config, 'utf8');
    await promisify(execFile)('mkfifo', [file('gate')]);
  });

  afterEach(async () => {
    waiting?.kill('SIGKILL');
    waiting = undefined;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('holds the lock while it reads, as a plan', async () => {
    await atTheGate('plan');

    const held = JSON.parse(await fs.readFile(lockFile(), 'utf8')) as { operation: string; pid: number };
    expect(held.operation).toBe('plan');
    expect(held.pid).toBe(waiting!.pid);
  });

  it.each([['plan'], ['apply', '--yes']])('refuses %s while it holds the lock', async (...args) => {
    await atTheGate('plan');

    const second = await run(...args);

    expect(second.code).toBe(1);
    expect(second.stderr).toContain(`State is locked by plan of ${os.userInfo().username} on ${os.hostname()}, pid ${waiting!.pid}`);
  });

  it('releases the lock once it is done', async () => {
    const { ended } = await atTheGate('plan');

    await fs.writeFile(file('gate'), 'open');

    const { code, stdout } = await ended;
    expect(code).toBe(0);
    expect(stdout).toContain('read = "open"');
    expect(await exists('clay.state.json.lock')).toBe(false);
  });

  it.each([['plan'], ['apply', '--yes']])('%s stops at once on Ctrl-C and releases the lock', async (...args) => {
    const { ended, stderr } = await atTheGate(...args);

    waiting!.kill('SIGINT');
    while (!stderr().includes('Interrupted. Nothing was written.')) await sleep(20);
    // A process exits only once its blocked read of the pipe returns; no plan runs on after that.
    await fs.writeFile(file('gate'), 'open');

    const { code, stdout } = await ended;
    expect(code).toBe(130);
    expect(stdout).not.toContain('read = "open"');
    expect(await exists('clay.state.json.lock')).toBe(false);
  });
});
