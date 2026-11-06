import { ChildProcess, execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify, stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clay } from '../helpers';

const config = `resource "command_exec" "made" {
  command = "touch made.txt"
}
`;

const question = 'Do you want to perform these actions?';

interface Ended {
  code: number | null;
  stdout: string;
  stderr: string;
}

describe('an apply and the state lock while it asks', () => {
  let dir: string;
  let asking: ChildProcess | undefined;

  const file = (name: string) => path.join(dir, name);

  const exists = (name: string) =>
    fs.access(file(name)).then(
      () => true,
      () => false
    );

  /** Starts an apply without --yes and returns once it asks its question. */
  const atTheQuestion = async (): Promise<{ child: ChildProcess; ended: Promise<Ended>; stderr: () => string }> => {
    const child = spawn('node', [clay, 'apply'], { cwd: dir });
    asking = child;
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    let exited = false;
    const ended = once(child, 'exit').then(([code]) => {
      exited = true;
      return { code: code as number | null, stdout: stripVTControlCharacters(stdout), stderr: stripVTControlCharacters(stderr) };
    });

    while (!stdout.includes(question)) {
      if (exited) throw new Error(`apply exited before it asked: ${stderr}`);
      await sleep(20);
    }

    return { child, ended, stderr: () => stderr };
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
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-apply-lock-'));
    await promisify(execFile)('node', [clay, 'init'], { cwd: dir });
    await fs.writeFile(file('main.clay'), config, 'utf8');
  });

  afterEach(async () => {
    asking?.kill('SIGKILL');
    asking = undefined;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('holds the lock while it waits for the answer', async () => {
    const { child } = await atTheQuestion();

    const held = JSON.parse(await fs.readFile(file('clay.state.json.lock'), 'utf8')) as { operation: string; pid: number };
    expect(held.operation).toBe('apply');
    expect(held.pid).toBe(child.pid);
  });

  it.each([['plan'], ['apply']])('refuses %s before it asks anything', async (...args) => {
    const { child } = await atTheQuestion();

    const second = await run(...args);

    expect(second.code).toBe(1);
    expect(second.stdout).not.toContain(question);
    expect(second.stderr).toContain(`State is locked by apply of ${os.userInfo().username} on ${os.hostname()}, pid ${child.pid}`);
    expect(JSON.parse(await fs.readFile(file('clay.state.json.lock'), 'utf8'))).toMatchObject({ operation: 'apply', pid: child.pid });
  });

  it('runs under the lock it took and releases it once done', async () => {
    const { child, ended } = await atTheQuestion();

    child.stdin!.write('yes\n');

    const { code, stdout } = await ended;
    expect(code).toBe(0);
    expect(stdout).toContain('Apply complete! Resources: 1 added');
    expect(await exists('made.txt')).toBe(true);
    expect(await exists('clay.state.json.lock')).toBe(false);
  });

  it('releases the lock and exits 1 when the answer is no', async () => {
    const { child, ended } = await atTheQuestion();

    child.stdin!.write('no\n');

    const { code, stderr } = await ended;
    expect(code).toBe(1);
    expect(stderr).toContain('Apply cancelled.');
    expect(await exists('made.txt')).toBe(false);
    expect(await exists('clay.state.json.lock')).toBe(false);
  });

  it('releases the lock and exits 1 when the input closes', async () => {
    const { child, ended } = await atTheQuestion();

    child.stdin!.end();

    const { code, stderr } = await ended;
    expect(code).toBe(1);
    expect(stderr).toContain('No answer: the input is closed');
    expect(await exists('clay.state.json.lock')).toBe(false);
  });

  it('stops at once on Ctrl-C at the question and releases the lock', async () => {
    const { child, ended } = await atTheQuestion();

    child.kill('SIGINT');

    const { code, stderr } = await ended;
    expect(code).toBe(130);
    expect(stderr).toContain('Interrupted. Nothing was written.');
    expect(await exists('made.txt')).toBe(false);
    expect(await exists('clay.state.json.lock')).toBe(false);
  });
});
