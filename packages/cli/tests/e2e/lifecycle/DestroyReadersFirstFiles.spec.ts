import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clay, clayOutput } from '../helpers';

describe('replacing a file and the file that reads it', () => {
  let dir: string;

  const clayIn = (...args: string[]) => clayOutput(dir, ...args);

  const failedIn = async (...args: string[]) => {
    try {
      await promisify(execFile)('node', [clay, ...args], { cwd: dir });
    } catch (error) {
      const { code, stdout, stderr } = error as { code: number; stdout: string; stderr: string };
      return { code, stdout: stripVTControlCharacters(stdout), stderr: stripVTControlCharacters(stderr) };
    }
    throw new Error(`clay ${args.join(' ')} exited 0`);
  };

  const file = (name: string) => path.join(dir, name);

  const written = (a: string, b: string) =>
    fs.writeFile(
      file('main.clay'),
      `resource "local_file" "a" {\n  path    = "${file(a)}"\n  content = "x"\n}\nresource "local_file" "b" {\n  path    = "${file(b)}"\n  content = local_file.a.id\n}\n`,
      'utf8'
    );

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-readers-files-'));
    await clayIn('init');
    await written('a1.txt', 'b1.txt');
    await clayIn('apply', '--yes');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('reports each replace once, and counts each destroy once', async () => {
    await written('a2.txt', 'b2.txt');

    const applied = await clayIn('apply', '--yes');

    expect(applied).toContain('  - local_file.b destroyed, to be made again\n  -+ local_file.a replaced\n  -+ local_file.b replaced\n');
    expect(applied).toContain('Apply complete! Resources: 2 added, 0 changed, 2 destroyed.');
    const files = await fs.readdir(dir);
    expect(files.filter((name) => name.endsWith('.txt')).sort()).toEqual(['a2.txt', 'b2.txt']);
    expect(await fs.readFile(file('b2.txt'), 'utf8')).toBe(file('a2.txt'));
  });

  it('names a file it destroyed first when the replace it waited for fails', async () => {
    await written('main.clay/a2.txt', 'b2.txt');

    const { code, stdout, stderr } = await failedIn('apply', '--yes');

    expect(code).toBe(1);
    expect(stdout).toContain('  - local_file.b destroyed, to be made again\n  - local_file.a destroyed, to be made again\n');
    expect(stderr).toContain('Apply failed: local_file.a: ');
    expect(await fs.readdir(dir)).not.toContain('b1.txt');
  });
});
