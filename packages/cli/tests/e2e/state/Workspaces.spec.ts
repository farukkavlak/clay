import { emptyState } from '@clay/core';
import { serializeState } from '@clay/state';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HttpStateServer } from '../../../../../tests/httpStateServer';
import { clay, clayOutput } from '../helpers';

const FILE = 'resource "local_file" "f" {\n  path    = "f.txt"\n  content = "x"\n}\noutput "o" {\n  value = local_file.f.content\n}\n';

/** What `apply` says of a plan made in another workspace. */
const refusedIn = (planned: string, current: string) => ({
  code: 1,
  stdout: '',
  stderr: `Apply failed: The plan was made in workspace "${planned}", and this is workspace "${current}". Select "${planned}", or plan again in "${current}".\n`,
});

/** Runs the command in `dir` with `answer` as its whole input, for a question it may ask. */
async function answeredIn(dir: string, answer: string, ...args: string[]): Promise<{ code: number | null; stdout: string }> {
  const child = spawn('node', [clay, ...args], { cwd: dir });
  let stdout = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  child.stdin.end(answer);
  const [code] = await once(child, 'exit');

  return { code: code as number | null, stdout: stripVTControlCharacters(stdout) };
}

describe('a workspace selected in .clay/workspace', () => {
  let dir: string;

  const refusal = async (...args: string[]): Promise<{ code: number; stderr: string }> => {
    try {
      await promisify(execFile)('node', [clay, ...args], { cwd: dir });
    } catch (error) {
      const failed = error as { code: number; stderr: string };
      return { code: failed.code, stderr: stripVTControlCharacters(failed.stderr) };
    }

    throw new Error('Expected the command to fail');
  };

  const answered = (answer: string, ...args: string[]) => answeredIn(dir, answer, ...args);

  const select = async (content: string) => {
    await fs.mkdir(path.join(dir, '.clay'), { recursive: true });
    await fs.writeFile(path.join(dir, '.clay', 'workspace'), content, 'utf8');
  };
  const devState = path.join('clay.workspaces', 'dev', 'clay.state.json');
  const makeDev = async () => {
    await fs.mkdir(path.join(dir, 'clay.workspaces', 'dev'), { recursive: true });
    await fs.writeFile(path.join(dir, devState), serializeState({ ...emptyState(), lineage: 'lineage' }), 'utf8');
  };
  const devResources = async () => Object.keys((JSON.parse(await fs.readFile(path.join(dir, devState), 'utf8')) as { resources: Record<string, unknown> }).resources);
  const exists = (name: string) =>
    fs.access(path.join(dir, name)).then(
      () => true,
      () => false
    );

  beforeEach(async () => {
    // Real, as the CLI names it: macOS reaches the temp folder through a link.
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'clay-workspaces-')));
    await fs.writeFile(path.join(dir, 'main.clay'), FILE, 'utf8');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('is the state a run reads and writes, leaving the default state alone', async () => {
    await makeDev();
    await select('dev\n');

    await clayOutput(dir, 'apply', '--yes');

    expect(await devResources()).toEqual(['local_file.f']);
    expect(await exists('clay.state.json')).toBe(false);
  });

  it('is the state every state command reads and changes', async () => {
    await makeDev();
    await select('dev\n');
    await clayOutput(dir, 'apply', '--yes');

    expect(await clayOutput(dir, 'state', 'list')).toContain('local_file.f');
    expect(await clayOutput(dir, 'state', 'show', 'local_file.f')).toContain('f.txt');
    expect(await clayOutput(dir, 'state', 'pull')).toContain('local_file.f');
    expect(await clayOutput(dir, 'output', '--json')).toContain('"x"');

    await clayOutput(dir, 'state', 'mv', 'local_file.f', 'local_file.g');
    expect(await devResources()).toEqual(['local_file.g']);
    await clayOutput(dir, 'state', 'rm', 'local_file.g');
    expect(await devResources()).toEqual([]);
    expect(await exists('clay.state.json')).toBe(false);
  });

  it('is the state whose lock force-unlock releases', async () => {
    await makeDev();
    await select('dev\n');
    const gone = { id: 'left-by-a-dead-run', operation: 'apply', who: 'someone', host: 'elsewhere', pid: 4242, created: '2026-11-13T10:00:00.000Z' };
    await fs.writeFile(path.join(dir, `${devState}.lock`), JSON.stringify(gone), 'utf8');

    expect(await clayOutput(dir, 'force-unlock', gone.id)).toBe(`Released lock ${gone.id} on ${path.join(dir, devState)}\n`);
    expect(await exists(`${devState}.lock`)).toBe(false);
  });

  it('is refused where it has no state, and nothing is written', async () => {
    await select('dev\n');

    const { code, stderr } = await refusal('apply', '--yes');

    expect(code).toBe(1);
    expect(stderr).toContain('Workspace "dev" does not exist');
    expect(await exists('clay.state.json')).toBe(false);
    expect(await exists('clay.workspaces')).toBe(false);
    expect(await exists('f.txt')).toBe(false);
  });

  it('is refused where the file names no valid workspace, naming the file', async () => {
    await select('../dev\n');

    const { code, stderr } = await refusal('plan');

    expect(code).toBe(1);
    expect(stderr).toContain(`Workspace name "../dev" in ${path.join(dir, '.clay', 'workspace')} is not valid`);
  });

  it('is not read by validate, which reads no state', async () => {
    await select('../dev\n');

    expect(await clayOutput(dir, 'validate')).toContain('valid');
  });

  it.each([
    ['plan', 'Planning in workspace "dev"...'],
    ['apply', 'Calculating plan in workspace "dev"...'],
    ['destroy', 'Calculating plan in workspace "dev"...'],
  ])('is named where %s starts', async (command, header) => {
    await makeDev();
    await select('dev\n');

    const { stdout } = await answered('no\n', command);

    expect(stdout.split('\n')[0]).toBe(header);
  });

  it('is named where a saved plan is applied', async () => {
    await makeDev();
    await select('dev\n');
    await clayOutput(dir, 'plan', '--out', 'saved.plan');

    expect(await clayOutput(dir, 'apply', 'saved.plan')).toMatch(/^Applying from saved plan in workspace "dev"\.\.\.\n/);
  });

  it.each([['apply'], ['destroy']])('is named in the question %s asks, and "no" changes nothing', async (command) => {
    await makeDev();
    await select('dev\n');
    if (command === 'destroy') await clayOutput(dir, 'apply', '--yes');
    const before = await devResources();

    const { code, stdout } = await answered('no\n', command);

    expect(stdout).toContain('Do you want to perform these actions in workspace "dev"?');
    expect(code).toBe(1);
    expect(await devResources()).toEqual(before);
  });

  it.each([
    ['plan', 'Planning...'],
    ['apply', 'Calculating plan...'],
  ])('is not named where %s runs on the default workspace', async (command, header) => {
    const { stdout } = await answered('no\n', command);

    expect(stdout.split('\n')[0]).toBe(header);
    expect(stdout).not.toContain('workspace');
  });
});

describe('clay workspace', () => {
  let dir: string;

  const run = async (...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    try {
      const { stdout, stderr } = await promisify(execFile)('node', [clay, ...args], { cwd: dir });
      return { code: 0, stdout: stripVTControlCharacters(stdout), stderr: stripVTControlCharacters(stderr) };
    } catch (error) {
      const failed = error as { code: number; stdout: string; stderr: string };
      return { code: failed.code, stdout: stripVTControlCharacters(failed.stdout), stderr: stripVTControlCharacters(failed.stderr) };
    }
  };
  const read = (name: string) => fs.readFile(path.join(dir, name), 'utf8');
  const resourcesIn = async (name: string) => Object.keys((JSON.parse(await read(name)) as { resources: Record<string, unknown> }).resources);
  const devState = path.join('clay.workspaces', 'dev', 'clay.state.json');

  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'clay-workspace-command-')));
    await fs.writeFile(path.join(dir, 'main.clay'), FILE, 'utf8');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('new makes a workspace with an empty state and selects it, so a run goes there', async () => {
    expect(await run('workspace', 'new', 'dev')).toEqual({ code: 0, stdout: '✓ Created and selected workspace "dev"\n', stderr: '' });
    expect(await read(path.join('.clay', 'workspace'))).toBe('dev\n');
    expect(await resourcesIn(devState)).toEqual([]);

    await run('apply', '--yes');

    expect(await resourcesIn(devState)).toEqual(['local_file.f']);
    await expect(fs.access(path.join(dir, 'clay.state.json'))).rejects.toThrow('ENOENT');
  });

  it('new refuses a workspace that exists, leaving its state and the selection as they were', async () => {
    await run('workspace', 'new', 'dev');
    await run('apply', '--yes');
    await run('workspace', 'select', 'default');

    expect(await run('workspace', 'new', 'dev')).toEqual({ code: 1, stdout: '', stderr: 'Failed to make the workspace: Workspace "dev" exists already\n' });
    expect(await resourcesIn(devState)).toEqual(['local_file.f']);
    expect(await read(path.join('.clay', 'workspace'))).toBe('default\n');
    await expect(fs.readdir(path.join(dir, 'clay.workspaces', 'dev'))).resolves.toEqual(['clay.state.json', 'clay.state.json.bak']);
  });

  it('new refuses the default workspace, which always exists', async () => {
    expect(await run('workspace', 'new', 'default')).toMatchObject({ code: 1, stderr: 'Failed to make the workspace: Workspace "default" exists already\n' });
    await expect(fs.readdir(dir)).resolves.toEqual(['main.clay']);
  });

  it('new refuses a name no workspace can have, before anything is made', async () => {
    const { code, stderr } = await run('workspace', 'new', '../dev');

    expect(code).toBe(1);
    expect(stderr).toContain('Workspace name "../dev" in the command line is not valid');
    await expect(fs.readdir(dir)).resolves.toEqual(['main.clay']);
    await expect(fs.readdir(path.dirname(dir))).resolves.not.toContain('dev');
  });

  it('new makes no folder the state a backend block places has not got', async () => {
    await fs.writeFile(path.join(dir, 'main.clay'), `clay {\n  backend "local" {\n    path = "kept/app.json"\n  }\n}\n${FILE}`, 'utf8');
    await fs.mkdir(path.join(dir, 'kept'));
    await run('init');
    await fs.rm(path.join(dir, 'kept'), { recursive: true });

    const { code, stderr } = await run('workspace', 'new', 'dev');

    expect(code).toBe(1);
    expect(stderr).toContain(`${path.join(dir, 'kept')} is not a directory`);
    await expect(fs.access(path.join(dir, 'kept'))).rejects.toThrow('ENOENT');
  });

  it('new makes one of two workspaces made at once with one name', async () => {
    const both = await Promise.all([run('workspace', 'new', 'dev'), run('workspace', 'new', 'dev')]);

    expect(both.map(({ code }) => code).sort()).toEqual([0, 1]);
    expect(await resourcesIn(devState)).toEqual([]);
  });

  it('init moves every workspace to the backend the configuration names, and keeps the old states', async () => {
    await run('apply', '--yes');
    for (const name of ['dev', 'pr-12']) {
      await fs.mkdir(path.join(dir, 'clay.workspaces', name), { recursive: true });
      await fs.copyFile(path.join(dir, 'clay.state.json'), path.join(dir, 'clay.workspaces', name, 'clay.state.json'));
    }
    await fs.mkdir(path.join(dir, '.clay'));
    await fs.writeFile(path.join(dir, '.clay', 'workspace'), 'pr-12\n', 'utf8');
    await fs.mkdir(path.join(dir, 'there'));
    await fs.writeFile(path.join(dir, 'main.clay'), `clay {\n  backend "local" {\n    path = "there/state.json"\n  }\n}\n${FILE}`, 'utf8');
    const to = path.join('there', 'state.json');
    const movedLine = (state: string) => `✓ Moved ${state} in "clay.state.json" to "${to}"; the old one is left as it was\n`;

    expect(await run('init', '--yes')).toEqual({
      code: 0,
      stdout: `Initializing Clay in this directory...\n${movedLine('the state of workspace "dev"')}${movedLine('the state of workspace "pr-12"')}${movedLine('the state')}\nClay initialized successfully! 🚀\n`,
      stderr: '',
    });
    expect(await run('workspace', 'list')).toMatchObject({ code: 0, stdout: '  default\n  dev\n* pr-12\n' });
    for (const name of ['dev', 'pr-12']) expect(await resourcesIn(path.join('there', 'clay.workspaces', name, 'state.json'))).toEqual(['local_file.f']);
    expect(await resourcesIn(to)).toEqual(['local_file.f']);
    expect(await resourcesIn(devState)).toEqual(['local_file.f']);
    expect(await run('plan')).toMatchObject({ code: 0, stdout: expect.stringContaining('No changes') });
  });

  it('init makes the default state where only named workspaces move, and takes them as they are when run again', async () => {
    await run('workspace', 'new', 'dev');
    await fs.mkdir(path.join(dir, 'there'));
    await fs.writeFile(path.join(dir, 'main.clay'), `clay {\n  backend "local" {\n    path = "there/state.json"\n  }\n}\n${FILE}`, 'utf8');
    const to = path.join('there', 'state.json');

    expect(await run('init', '--yes')).toMatchObject({
      code: 0,
      stdout: `Initializing Clay in this directory...\n✓ Moved the state of workspace "dev" in "clay.state.json" to "${to}"; the old one is left as it was\n✓ Created an empty state\n\nClay initialized successfully! 🚀\n`,
    });
    expect(await resourcesIn(to)).toEqual([]);
    await fs.rm(path.join(dir, '.clay', 'backend.json'));

    expect(await run('init')).toMatchObject({
      code: 0,
      stdout: `Initializing Clay in this directory...\n✓ Took the state of workspace "dev" in "${to}", which is the same as in "clay.state.json"\n✓ Kept the state already here\n\nClay initialized successfully! 🚀\n`,
    });
  });

  it('init asks once about every workspace, and moves none on no', async () => {
    await run('apply', '--yes');
    await run('workspace', 'new', 'dev');
    await fs.mkdir(path.join(dir, 'there'));
    await fs.writeFile(path.join(dir, 'main.clay'), `clay {\n  backend "local" {\n    path = "there/state.json"\n  }\n}\n${FILE}`, 'utf8');

    const { code, stdout } = await answeredIn(dir, 'n\n', 'init');

    expect(code).toBe(1);
    expect(stdout).toContain(`Move the states of workspaces "dev", "default" in "clay.state.json" (local) to "${path.join('there', 'state.json')}" (local)?`);
    await expect(fs.readdir(path.join(dir, 'there'))).resolves.toEqual([]);
    await expect(fs.readdir(path.join(dir, '.clay'))).resolves.toEqual(['workspace']);
  });

  it('select runs the commands that follow on the workspace it names', async () => {
    await run('workspace', 'new', 'dev');

    expect(await run('workspace', 'select', 'default')).toEqual({ code: 0, stdout: '✓ Selected workspace "default"\n', stderr: '' });
    await run('apply', '--yes');

    expect(await resourcesIn('clay.state.json')).toEqual(['local_file.f']);
    expect(await resourcesIn(devState)).toEqual([]);
  });

  it('select refuses a workspace that does not exist, and keeps the one selected', async () => {
    await run('workspace', 'new', 'dev');

    expect(await run('workspace', 'select', 'test')).toEqual({
      code: 1,
      stdout: '',
      stderr: 'Failed to select the workspace: Workspace "test" does not exist; run `clay workspace new test` to make it\n',
    });
    expect(await read(path.join('.clay', 'workspace'))).toBe('dev\n');
  });

  it('show prints the selected workspace, the default one where none is selected', async () => {
    expect(await run('workspace', 'show')).toEqual({ code: 0, stdout: 'default\n', stderr: '' });
    await run('workspace', 'new', 'dev');
    expect(await run('workspace', 'show')).toEqual({ code: 0, stdout: 'dev\n', stderr: '' });
  });

  it('show refuses a selection no workspace can be named', async () => {
    await fs.mkdir(path.join(dir, '.clay'));
    await fs.writeFile(path.join(dir, '.clay', 'workspace'), 'Dev\n', 'utf8');

    expect(await run('workspace', 'show')).toMatchObject({ code: 1, stdout: '' });
  });

  it('list names every workspace and marks the selected one', async () => {
    expect(await run('workspace', 'list')).toEqual({ code: 0, stdout: '* default\n', stderr: '' });
    await run('workspace', 'new', 'test');
    await run('workspace', 'new', 'dev');

    expect(await run('workspace', 'list')).toEqual({ code: 0, stdout: '  default\n* dev\n  test\n', stderr: '' });
  });

  it('delete removes a workspace with nothing in its state, and the folders it was in', async () => {
    await run('workspace', 'new', 'dev');
    await run('workspace', 'select', 'default');

    expect(await run('workspace', 'delete', 'dev')).toEqual({ code: 0, stdout: '✓ Deleted workspace "dev"\n', stderr: '' });
    await expect(fs.readdir(dir)).resolves.toEqual(['.clay', 'main.clay']);
    expect(await run('workspace', 'list')).toMatchObject({ stdout: '* default\n' });
  });

  it('delete refuses a workspace whose state holds resources, and --force deletes it, leaving them', async () => {
    await run('workspace', 'new', 'dev');
    await run('apply', '--yes');
    await run('workspace', 'select', 'default');

    expect(await run('workspace', 'delete', 'dev')).toEqual({
      code: 1,
      stdout: '',
      stderr:
        'Failed to delete the workspace: Workspace "dev" still has resources in its state; destroy them with `clay destroy` in that workspace first, or delete it with --force, which forgets them and leaves them in place\n',
    });
    expect(await resourcesIn(devState)).toEqual(['local_file.f']);

    expect(await run('workspace', 'delete', 'dev', '--force')).toMatchObject({ code: 0, stdout: '✓ Deleted workspace "dev"\n' });
    await expect(fs.access(path.join(dir, 'clay.workspaces'))).rejects.toThrow('ENOENT');
    expect(await read('f.txt')).toBe('x');
  });

  it('delete refuses a workspace whose state holds only deposed objects', async () => {
    await run('workspace', 'new', 'dev');
    await run('workspace', 'select', 'default');
    const deposed = { 'local_file.f': [{ attributes: { path: 'f.txt', content: 'x' } }] };
    await fs.writeFile(path.join(dir, devState), serializeState({ ...emptyState(), lineage: 'lineage', deposed }), 'utf8');

    expect(await run('workspace', 'delete', 'dev')).toMatchObject({ code: 1, stderr: expect.stringContaining('Workspace "dev" still has resources in its state') });
    expect(JSON.parse(await read(devState))).toMatchObject({ deposed });
  });

  it('delete --force removes a workspace whose state cannot be read', async () => {
    await run('workspace', 'new', 'dev');
    await run('workspace', 'select', 'default');
    await fs.writeFile(path.join(dir, devState), '{ not json', 'utf8');

    expect(await run('workspace', 'delete', 'dev')).toMatchObject({ code: 1 });
    expect(await run('workspace', 'delete', 'dev', '--force')).toMatchObject({ code: 0, stdout: '✓ Deleted workspace "dev"\n' });
    await expect(fs.access(path.join(dir, 'clay.workspaces'))).rejects.toThrow('ENOENT');
  });

  it('delete refuses the selected workspace, which every command that follows would miss', async () => {
    await run('workspace', 'new', 'dev');

    expect(await run('workspace', 'delete', 'dev')).toMatchObject({
      code: 1,
      stderr: 'Failed to delete the workspace: Workspace "dev" is selected; select another one before deleting it\n',
    });
    expect(await resourcesIn(devState)).toEqual([]);
  });

  it('delete refuses the default workspace, which always exists', async () => {
    await run('apply', '--yes');

    expect(await run('workspace', 'delete', 'default')).toMatchObject({
      code: 1,
      stderr: 'Failed to delete the workspace: Workspace "default" always exists, and cannot be deleted\n',
    });
    expect(await resourcesIn('clay.state.json')).toEqual(['local_file.f']);
  });

  it('delete refuses a workspace that does not exist, and makes nothing', async () => {
    expect(await run('workspace', 'delete', 'dev')).toMatchObject({ code: 1, stderr: 'Failed to delete the workspace: Workspace "dev" does not exist\n' });
    await expect(fs.readdir(dir)).resolves.toEqual(['main.clay']);
  });

  it('delete refuses a name no workspace can have, and makes nothing', async () => {
    const { code, stderr } = await run('workspace', 'delete', '../dev');

    expect(code).toBe(1);
    expect(stderr).toContain('Workspace name "../dev" in the command line is not valid');
    await expect(fs.readdir(dir)).resolves.toEqual(['main.clay']);
  });

  it('delete refuses a workspace another run holds the lock of, and keeps it', async () => {
    await run('workspace', 'new', 'dev');
    await run('workspace', 'select', 'default');
    await fs.writeFile(path.join(dir, `${devState}.lock`), JSON.stringify({ id: 'other', operation: 'apply', who: 'me', host: 'here', pid: 1, created: 'now' }), 'utf8');

    const { code, stderr } = await run('workspace', 'delete', 'dev');

    expect(code).toBe(1);
    expect(stderr).toContain('Failed to delete the workspace: State is locked by apply of me on here');
    expect(await resourcesIn(devState)).toEqual([]);
  });
});

describe('CLAY_WORKSPACE', () => {
  let dir: string;

  const runWith = async (workspace: string | undefined, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    const env = { ...process.env, CLAY_WORKSPACE: workspace };
    try {
      const { stdout, stderr } = await promisify(execFile)('node', [clay, ...args], { cwd: dir, env });
      return { code: 0, stdout: stripVTControlCharacters(stdout), stderr: stripVTControlCharacters(stderr) };
    } catch (error) {
      const failed = error as { code: number; stdout: string; stderr: string };
      return { code: failed.code, stdout: stripVTControlCharacters(failed.stdout), stderr: stripVTControlCharacters(failed.stderr) };
    }
  };
  const printedWith = async (workspace: string, ...args: string[]) => {
    const { stdout } = await runWith(workspace, ...args);
    return stdout;
  };
  const stateOf = (name: string) => path.join('clay.workspaces', name, 'clay.state.json');
  const selection = path.join('.clay', 'workspace');
  const read = (name: string) => fs.readFile(path.join(dir, name), 'utf8');
  const resourcesIn = async (name: string) => Object.keys((JSON.parse(await read(name)) as { resources: Record<string, unknown> }).resources);
  const missing = (name: string) => expect(fs.access(path.join(dir, name))).rejects.toThrow('ENOENT');
  const select = async (content: string) => {
    await fs.mkdir(path.join(dir, '.clay'), { recursive: true });
    await fs.writeFile(path.join(dir, selection), content, 'utf8');
  };

  const changeContent = async () => fs.writeFile(path.join(dir, 'main.clay'), FILE.replace('"x"', '"y"'), 'utf8');

  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'clay-workspace-variable-')));
    await fs.writeFile(path.join(dir, 'main.clay'), FILE, 'utf8');
    await runWith(undefined, 'workspace', 'new', 'dev');
    await runWith(undefined, 'workspace', 'new', 'test');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('runs one command on the workspace it names, over the selected one, which stays selected', async () => {
    expect(await runWith('dev', 'apply', '--yes')).toMatchObject({ code: 0 });

    expect(await resourcesIn(stateOf('dev'))).toEqual(['local_file.f']);
    expect(await resourcesIn(stateOf('test'))).toEqual([]);
    expect(await read(selection)).toBe('test\n');
  });

  describe('with a saved plan', () => {
    it('refuses it in another workspace, even on a copy of its state, and applies it in its own', async () => {
      await runWith('dev', 'apply', '--yes');
      await fs.copyFile(path.join(dir, stateOf('dev')), path.join(dir, stateOf('test')));
      const copied = await read(stateOf('test'));
      await changeContent();
      await runWith('dev', 'plan', '--out', 'p.json');

      expect(await runWith('test', 'apply', 'p.json')).toEqual(refusedIn('dev', 'test'));
      expect(await read(stateOf('test'))).toBe(copied);
      expect(await read('f.txt')).toBe('x');

      expect(await runWith('dev', 'apply', 'p.json')).toMatchObject({ code: 0 });
      expect(await read('f.txt')).toBe('y');
    });

    it('refuses one made in the default workspace in a named one', async () => {
      await runWith('default', 'plan', '--out', 'p.json');

      expect(await runWith('dev', 'apply', 'p.json')).toEqual(refusedIn('default', 'dev'));
    });

    it('names both workspaces where the one in use does not exist', async () => {
      await runWith('dev', 'plan', '--out', 'p.json');

      expect(await runWith('gone', 'apply', 'p.json')).toEqual(refusedIn('dev', 'gone'));
    });
  });

  it('names the workspace where a plan starts', async () => {
    expect(await printedWith('dev', 'plan')).toMatch(/^Planning in workspace "dev"\.\.\.\n/);
  });

  it('is what every state command reads and changes', async () => {
    await runWith('dev', 'apply', '--yes');

    expect(await printedWith('dev', 'state', 'list')).toContain('local_file.f');
    expect(await printedWith('test', 'state', 'list')).not.toContain('local_file.f');
    expect(await printedWith('dev', 'state', 'show', 'local_file.f')).toContain('f.txt');
    expect(await printedWith('dev', 'state', 'pull')).toContain('local_file.f');
    expect(await printedWith('dev', 'output', '--json')).toContain('"x"');

    await runWith('dev', 'state', 'mv', 'local_file.f', 'local_file.g');
    expect(await resourcesIn(stateOf('dev'))).toEqual(['local_file.g']);
  });

  it('is the workspace whose lock force-unlock releases', async () => {
    const gone = { id: 'left-by-a-dead-run', operation: 'apply', who: 'someone', host: 'elsewhere', pid: 4242, created: '2026-11-13T10:00:00.000Z' };
    await fs.writeFile(path.join(dir, `${stateOf('dev')}.lock`), JSON.stringify(gone), 'utf8');

    expect(await printedWith('dev', 'force-unlock', gone.id)).toBe(`Released lock ${gone.id} on ${path.join(dir, stateOf('dev'))}\n`);
    await missing(`${stateOf('dev')}.lock`);
  });

  it('may name the default workspace, over a selected one', async () => {
    await runWith('default', 'apply', '--yes');

    expect(await resourcesIn('clay.state.json')).toEqual(['local_file.f']);
    expect(await resourcesIn(stateOf('test'))).toEqual([]);
  });

  it('counts as unset where it is empty', async () => {
    await runWith('', 'apply', '--yes');

    expect(await resourcesIn(stateOf('test'))).toEqual(['local_file.f']);
  });

  it('is refused where it names no valid workspace, naming the variable', async () => {
    expect(await runWith('../dev', 'plan')).toMatchObject({ code: 1, stderr: expect.stringContaining('Workspace name "../dev" in CLAY_WORKSPACE is not valid') as string });
  });

  it('is refused where its workspace does not exist, and nothing is written', async () => {
    const result = await runWith('nope', 'apply', '--yes');

    expect(result).toMatchObject({ code: 1, stderr: expect.stringContaining('Workspace "nope" does not exist') as string });
    await missing(path.join('clay.workspaces', 'nope'));
    await missing('f.txt');
  });

  it('leaves a selection no workspace can be named unread', async () => {
    await select('../bad\n');

    expect(await runWith('dev', 'workspace', 'show')).toEqual({ code: 0, stdout: 'dev\n', stderr: '' });
  });

  it('is not read by validate and init, which run on no workspace', async () => {
    expect(await runWith('../dev', 'validate')).toMatchObject({ code: 0 });
    expect(await runWith('../dev', 'init')).toMatchObject({ code: 0 });
  });

  it('is what show prints', async () => {
    expect(await runWith('dev', 'workspace', 'show')).toEqual({ code: 0, stdout: 'dev\n', stderr: '' });
  });

  it('is what list marks', async () => {
    expect(await runWith('dev', 'workspace', 'list')).toEqual({ code: 0, stdout: '  default\n* dev\n  test\n', stderr: '' });
  });

  it('refuses select, which it would overrule, and the selection stays', async () => {
    expect(await runWith('dev', 'workspace', 'select', 'dev')).toEqual({
      code: 1,
      stdout: '',
      stderr: 'Failed to select the workspace: CLAY_WORKSPACE chooses the workspace, so selecting one would change nothing; unset it first\n',
    });
    expect(await read(selection)).toBe('test\n');
  });

  it('lets new make the workspace it names, and the selection stays', async () => {
    expect(await runWith('pr-12', 'workspace', 'new', 'pr-12')).toEqual({ code: 0, stdout: '✓ Created workspace "pr-12"\n', stderr: '' });

    expect(await resourcesIn(stateOf('pr-12'))).toEqual([]);
    expect(await read(selection)).toBe('test\n');
  });

  it('refuses new for another workspace, and makes nothing', async () => {
    expect(await runWith('dev', 'workspace', 'new', 'pr-12')).toEqual({
      code: 1,
      stdout: '',
      stderr: 'Failed to make the workspace: CLAY_WORKSPACE names workspace "dev"; unset it, or set it to "pr-12", to make "pr-12"\n',
    });
    await missing(path.join('clay.workspaces', 'pr-12'));
    expect(await read(selection)).toBe('test\n');
  });

  it('lets delete remove the workspace it names, where the file selects another', async () => {
    expect(await runWith('dev', 'workspace', 'delete', 'dev')).toEqual({ code: 0, stdout: '✓ Deleted workspace "dev"\n', stderr: '' });

    await missing(path.join('clay.workspaces', 'dev'));
    expect(await read(selection)).toBe('test\n');
  });

  it('is refused by delete where it names no valid workspace, and the workspace stays', async () => {
    expect(await runWith('../bad', 'workspace', 'delete', 'dev')).toMatchObject({
      code: 1,
      stderr: expect.stringContaining('Workspace name "../bad" in CLAY_WORKSPACE is not valid') as string,
    });
    expect(await resourcesIn(stateOf('dev'))).toEqual([]);
  });

  it('does not let delete remove the workspace the file selects', async () => {
    expect(await runWith('test', 'workspace', 'delete', 'test')).toMatchObject({
      code: 1,
      stderr: 'Failed to delete the workspace: Workspace "test" is selected; select another one before deleting it\n',
    });
    expect(await resourcesIn(stateOf('test'))).toEqual([]);
  });

  it('carries a workspace from new to delete with the selection untouched', async () => {
    await fs.rm(path.join(dir, selection));

    for (const command of [
      ['workspace', 'new', 'pr-12'],
      ['apply', '--yes'],
      ['destroy', '--yes'],
      ['workspace', 'delete', 'pr-12'],
    ])
      expect(await runWith('pr-12', ...command)).toMatchObject({ code: 0 });

    await missing(path.join('clay.workspaces', 'pr-12'));
    await missing(selection);
  });
});

describe('clay workspace on a backend that keeps one state', () => {
  let dir: string;
  let server: HttpStateServer;

  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'clay-workspace-http-')));
    server = await HttpStateServer.start();
    await fs.writeFile(
      path.join(dir, 'main.clay'),
      `clay {\n  backend "http" {\n    address      = "${server.url}/state"\n    lock_address = "${server.url}/lock"\n  }\n}\n${FILE}`,
      'utf8'
    );
    await clayOutput(dir, 'init');
  });

  afterEach(async () => {
    await server.stop();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('lists the default workspace alone', async () => {
    expect(await clayOutput(dir, 'workspace', 'list')).toBe('* default\n');
  });

  it('refuses a new workspace, and makes nothing', async () => {
    const before = server.state;
    let stderr = '';
    try {
      await promisify(execFile)('node', [clay, 'workspace', 'new', 'dev'], { cwd: dir });
    } catch (error) {
      stderr = stripVTControlCharacters((error as { stderr: string }).stderr);
    }

    expect(stderr).toBe('Failed to make the workspace: Backend "http" keeps one state, so workspace "dev" cannot be used\n');
    expect(server.state).toBe(before);
    await expect(fs.access(path.join(dir, '.clay', 'workspace'))).rejects.toThrow('ENOENT');
  });

  it('refuses to delete a workspace, and changes nothing', async () => {
    const before = server.state;
    let stderr = '';
    try {
      await promisify(execFile)('node', [clay, 'workspace', 'delete', 'dev'], { cwd: dir });
    } catch (error) {
      stderr = stripVTControlCharacters((error as { stderr: string }).stderr);
    }

    expect(stderr).toBe('Failed to delete the workspace: Backend "http" keeps one state, so workspace "dev" cannot be used\n');
    expect(server.state).toBe(before);
  });
});
