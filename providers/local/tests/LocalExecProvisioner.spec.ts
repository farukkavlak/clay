import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalExecProvisioner } from '../src/index';

describe('LocalExecProvisioner', () => {
  const provisioner = new LocalExecProvisioner();
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-exec-test-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('runs its command through the shell', async () => {
    const file = path.join(dir, 'made.txt');

    await provisioner.run({ command: `echo made > '${file}'` });

    expect(await fs.readFile(file, 'utf8')).toBe('made\n');
  });

  it('fails with the command when it exits with another code than 0', async () => {
    await expect(provisioner.run({ command: 'exit 3' })).rejects.toThrow('Command failed: exit 3');
  });

  it('refuses an empty command, and takes any other', async () => {
    await expect(provisioner.validate({ command: '' })).rejects.toThrow('local-exec "command" must not be empty');
    await expect(provisioner.validate({ command: ' ' })).resolves.toBeUndefined();
  });

  it('requires a command, which is a string', async () => {
    expect(await provisioner.getSchema()).toEqual({ command: { type: { kind: 'string' }, required: true } });
  });
});
