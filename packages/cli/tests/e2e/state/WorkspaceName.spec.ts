import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clay } from '../helpers';

const NAMED = 'resource "local_file" "f" {\n  path    = "${clay.workspace}.txt"\n  content = clay.workspace\n}\noutput "name" {\n  value = clay.workspace\n}\n';

describe('clay.workspace', () => {
  let dir: string;

  const run = async (env: Record<string, string>, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    try {
      const { stdout, stderr } = await promisify(execFile)('node', [clay, ...args], { cwd: dir, env: { ...process.env, CLAY_WORKSPACE: '', ...env } });
      return { code: 0, stdout: stripVTControlCharacters(stdout), stderr: stripVTControlCharacters(stderr) };
    } catch (error) {
      const failed = error as { code: number; stdout: string; stderr: string };
      return { code: failed.code, stdout: stripVTControlCharacters(failed.stdout), stderr: stripVTControlCharacters(failed.stderr) };
    }
  };
  const inDir = (...args: string[]) => run({}, ...args);
  const succeeds = async (...args: string[]) => {
    const result = await inDir(...args);
    expect(result).toMatchObject({ code: 0, stderr: '' });
    return result.stdout;
  };
  const configure = (config: string) => fs.writeFile(path.join(dir, 'main.clay'), config, 'utf8');
  const textOf = (name: string) => fs.readFile(path.join(dir, name), 'utf8');

  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'clay-workspace-name-')));
    await configure(NAMED);
    await succeeds('init');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('is default where no workspace is selected', async () => {
    await succeeds('apply', '--yes');

    expect(await textOf('default.txt')).toBe('default');
    expect(await succeeds('output', 'name')).toContain('name = "default"');
  });

  it('is the selected workspace, in each state apart', async () => {
    await succeeds('apply', '--yes');
    await succeeds('workspace', 'new', 'dev');

    await succeeds('apply', '--yes');

    expect(await textOf('dev.txt')).toBe('dev');
    expect(await textOf('default.txt')).toBe('default');
    expect(await succeeds('output', 'name')).toContain('name = "dev"');
  });

  it('is the one CLAY_WORKSPACE names, over the selected one', async () => {
    await succeeds('workspace', 'new', 'dev');
    await succeeds('workspace', 'new', 'qa');

    expect(await run({ CLAY_WORKSPACE: 'dev' }, 'apply', '--yes')).toMatchObject({ code: 0 });

    expect(await textOf('dev.txt')).toBe('dev');
    await expect(textOf('qa.txt')).rejects.toThrow('ENOENT');
  });

  it('is read the same in a module', async () => {
    await fs.mkdir(path.join(dir, 'm'));
    await fs.writeFile(path.join(dir, 'm', 'main.clay'), 'output "name" {\n  value = clay.workspace\n}\n', 'utf8');
    await configure('module "m" {\n  source = "./m"\n}\noutput "name" {\n  value = module.m.name\n}\n');
    await succeeds('workspace', 'new', 'dev');

    await succeeds('apply', '--yes');

    expect(await succeeds('output', 'name')).toContain('name = "dev"');
  });

  it('decides a count at plan', async () => {
    await configure('resource "local_file" "f" {\n  count   = clay.workspace == "prod" ? 1 : 0\n  path    = "f.txt"\n  content = "x"\n}\n');
    expect(await succeeds('plan')).toContain('No changes');

    await succeeds('workspace', 'new', 'prod');

    expect(await succeeds('plan')).toContain('local_file.f[0] will be created');
  });

  it('holds its value from a saved plan to the apply', async () => {
    await succeeds('workspace', 'new', 'dev');
    await succeeds('plan', '--out', 'p.json');

    await succeeds('apply', 'p.json');

    expect(await textOf('dev.txt')).toBe('dev');
    expect(await succeeds('output', 'name')).toContain('name = "dev"');
  });

  it('is not known to validate, which needs no workspace to exist', async () => {
    await fs.mkdir(path.join(dir, '.clay'), { recursive: true });
    await fs.writeFile(path.join(dir, '.clay', 'workspace'), 'gone\n', 'utf8');
    await configure('resource "local_file" "f" {\n  count   = clay.workspace == "prod" ? 1 : 0\n  path    = "${clay.workspace}.txt"\n  content = "x"\n}\n');

    expect(await inDir('validate')).toMatchObject({ code: 0, stdout: expect.stringContaining('Configuration is valid') });
    expect(await inDir('plan')).toMatchObject({ code: 1, stderr: expect.stringContaining('Workspace "gone" does not exist') });
  });

  it('makes no instance in validate, since another workspace may make none', async () => {
    await configure(
      'locals {\n  names = []\n}\nresource "local_file" "f" {\n  count   = clay.workspace == "default" ? 1 : 0\n  path    = "f.txt"\n  content = local.names[count.index]\n}\n'
    );

    expect(await inDir('validate')).toMatchObject({ code: 0 });
    expect(await inDir('plan')).toMatchObject({ code: 1, stderr: expect.stringContaining('main.clay line 7') });
  });

  it('is not known where a block is read as written, which holds for every workspace', async () => {
    await configure(
      'locals {\n  names = ["a"]\n}\nresource "local_file" "f" {\n  count   = 0\n  path    = "f.txt"\n  content = local.names[clay.workspace == "default" ? 1 : 0]\n}\n'
    );

    expect(await succeeds('plan')).toContain('No changes');
  });

  it('refuses a mistake only another workspace would reach, in every workspace', async () => {
    await configure('output "o" {\n  value = clay.workspace == "prod" ? tolist([1, true]) : ["x"]\n}\n');

    for (const command of ['validate', 'plan']) expect(await inDir(command)).toMatchObject({ code: 1, stderr: expect.stringContaining('main.clay line 2') });
  });

  it.each([
    ['a name it does not have', 'output "o" {\n  value = clay.nope\n}\n', 'clay.workspace is the name of the workspace a command runs on'],
    ['a step into it', 'output "o" {\n  value = clay.workspace.x\n}\n', 'main.clay line 2'],
    ['a default that reads it', 'variable "v" {\n  default = clay.workspace\n}\n', 'main.clay line 2'],
  ])('refuses %s', async (_title, config, message) => {
    await configure(config);

    expect(await inDir('validate')).toMatchObject({ code: 1, stderr: expect.stringContaining(message) });
  });
});
