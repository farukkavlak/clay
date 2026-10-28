import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

  it('refuses an empty command, and takes any other', async () => {
    await expect(provisioner.validate({ command: '' })).rejects.toThrow('local-exec "command" must not be empty');
    await expect(provisioner.validate({ command: ' ' })).resolves.toBeUndefined();
  });

  it('requires a command, which is a string, and takes quiet, a bool', async () => {
    expect(await provisioner.getSchema()).toEqual({ command: { type: { kind: 'string' }, required: true }, quiet: { type: { kind: 'bool' }, required: false } });
  });
});
