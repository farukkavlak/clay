import { UNKNOWN } from '@clay/contracts';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocalExecProvisioner } from '../src/index';

const pause = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

describe('LocalExecProvisioner', () => {
  const provisioner = new LocalExecProvisioner();
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-exec-test-'));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(dir, { recursive: true, force: true });
  });

  /** Runs `config`, and gives each line it printed. */
  const printed = async (config: Record<string, unknown>): Promise<string[]> => {
    const lines: string[] = [];
    await provisioner.run(config, (line) => lines.push(line));
    return lines;
  };

  it('runs its command through the shell', async () => {
    const file = path.join(dir, 'made.txt');

    await printed({ command: `echo made > '${file}'` });

    expect(await fs.readFile(file, 'utf8')).toBe('made\n');
  });

  it('gives the command, then each line it prints on stdout and stderr, as it prints it', async () => {
    const go = path.join(dir, 'go');
    const command = `echo one; echo two >&2; while [ ! -f '${go}' ]; do sleep 0.01; done; echo three`;
    const lines: string[] = [];
    const running = provisioner.run({ command }, (line) => lines.push(line));

    // The command waits for this test, so what it gave first came before it ended.
    while (lines.length < 3) await pause(5);
    const before = [...lines];
    await fs.writeFile(go, '');
    await running;

    expect(before[0]).toBe(`Executing: ${JSON.stringify(command)}`);
    // Two streams, so the order between them is not held.
    expect(before.slice(1).sort()).toEqual(['one', 'two']);
    expect(lines).toEqual([...before, 'three']);
  });

  it('gives a last line with no line break, and a line ending CRLF without its CR', async () => {
    expect(await printed({ command: String.raw`printf 'a\r\nb'`, quiet: true })).toEqual(['a', 'b']);
  });

  it('does not give the command when it is quiet', async () => {
    expect(await printed({ command: 'echo one', quiet: true })).toEqual(['one']);
  });

  it('fails with the code it exits with, and not the command, after giving what it printed', async () => {
    const lines: string[] = [];

    await expect(provisioner.run({ command: 'echo s3cr3t; exit 3', quiet: true }, (line) => lines.push(line))).rejects.toThrow(/^the command exited with 3$/);
    expect(lines).toEqual(['s3cr3t']);
  });

  it('fails with the signal that stopped it', async () => {
    await expect(printed({ command: 'kill -TERM $$' })).rejects.toThrow(/^the command was stopped by SIGTERM$/);
  });

  it('runs in working_dir, read from the directory Clay runs in', async () => {
    // It prints where it runs, and writes nothing, so a working_dir not taken cannot write into the repository.
    expect(await printed({ command: 'pwd -P', working_dir: path.relative(process.cwd(), dir), quiet: true })).toEqual([await fs.realpath(dir)]);
  });

  it.each([
    ['that does not exist', 'nope'],
    ['that is a file', 'file.txt'],
    ['under a file', 'file.txt/nope'],
  ])('fails before it runs, with working_dir a path %s', async (_, name) => {
    await fs.writeFile(path.join(dir, 'file.txt'), '');
    const missing = path.join(dir, name);
    const lines: string[] = [];

    await expect(provisioner.run({ command: 'echo ran', working_dir: missing }, (line) => lines.push(line))).rejects.toThrow(
      `working_dir ${JSON.stringify(missing)} is not a directory`
    );
    expect(lines).toEqual([]);
  });

  it('runs with the variables given set over its own environment, and leaves one given null as it is', async () => {
    vi.stubEnv('CLAY_KEPT', 'kept');
    vi.stubEnv('CLAY_OVER', 'old');
    vi.stubEnv('CLAY_NULL', 'inherited');
    const environment = { CLAY_GIVEN: 'given', CLAY_OVER: 'new', CLAY_NULL: null };

    expect(await printed({ command: 'echo "$CLAY_GIVEN $CLAY_KEPT $CLAY_OVER $CLAY_NULL"', environment, quiet: true })).toEqual(['given kept new inherited']);
  });

  it.each([
    ['an empty name', { '': 'x' }, 'local-exec "environment" cannot name a variable ""'],
    ['a name with =', { 'A=B': 'x' }, 'local-exec "environment" cannot name a variable "A=B"'],
    ['a name with a NUL character', { 'A\0B': 'x' }, String.raw`local-exec "environment" cannot name a variable "A\u0000B"`],
    ['a value with a NUL character', { A: 'x\0y' }, 'local-exec "environment" gives A a NUL character'],
  ])('refuses an environment with %s', async (_, environment, message) => {
    await expect(provisioner.validate({ command: 'x', environment })).rejects.toThrow(message);
  });

  it.each([
    ['not known yet', UNKNOWN],
    ['with a value not known yet', { A: UNKNOWN }],
    ['with a value null', { A: null }],
    ['null', null],
  ])('takes an environment %s', async (_, environment) => {
    await expect(provisioner.validate({ command: 'x', environment })).resolves.toBeUndefined();
  });

  it('refuses an empty working_dir, and takes any other', async () => {
    await expect(provisioner.validate({ command: 'x', working_dir: '' })).rejects.toThrow('local-exec "working_dir" must not be empty');
    await expect(provisioner.validate({ command: 'x', working_dir: ' ' })).resolves.toBeUndefined();
  });

  it('refuses an empty command, and takes any other', async () => {
    await expect(provisioner.validate({ command: '' })).rejects.toThrow('local-exec "command" must not be empty');
    await expect(provisioner.validate({ command: ' ' })).resolves.toBeUndefined();
  });

  it('requires a command, a string, and takes working_dir, a string, environment, a map of strings, and quiet, a bool', async () => {
    expect(await provisioner.getSchema()).toEqual({
      command: { type: { kind: 'string' }, required: true },
      working_dir: { type: { kind: 'string' }, required: false },
      environment: { type: { kind: 'map', element: { kind: 'string' } }, required: false },
      quiet: { type: { kind: 'bool' }, required: false },
    });
  });
});
