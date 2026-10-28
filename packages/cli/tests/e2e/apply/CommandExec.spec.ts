import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clayOutput } from '../helpers';

describe('a command_exec cwd', () => {
  let dir: string;

  const write = (cwd: string) => fs.writeFile(path.join(dir, 'main.clay'), `resource "command_exec" "c" {\n  command = "touch ran"\n  cwd     = "${cwd}"\n}\n`, 'utf8');

  /** What the command said on stderr. */
  const failure = async (...args: string[]): Promise<string> => {
    try {
      await clayOutput(dir, ...args);
    } catch (error) {
      return stripVTControlCharacters((error as { stderr: string }).stderr);
    }

    throw new Error('Expected the command to fail');
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-command-exec-'));
    await clayOutput(dir, 'init');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('is refused by plan when empty, where it is written', async () => {
    await write('');

    const stderr = await failure('plan');

    expect(stderr).toContain('command_exec "cwd" must not be empty');
    expect(stderr).toContain('line 1, in resource "command_exec" "c"');
  });

  it('fails the apply before the command runs when it is not a directory', async () => {
    await write('nope');

    const stderr = await failure('apply', '--yes');

    expect(stderr).toContain('command_exec.c: cwd "nope" is not a directory');
    await expect(fs.access(path.join(dir, 'ran'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
