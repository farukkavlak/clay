import { emptyState } from '@clay/contracts';
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

  /** Runs the command with `answer` as its whole input, for a question it may ask. */
  const answered = async (answer: string, ...args: string[]): Promise<{ code: number | null; stdout: string }> => {
    const child = spawn('node', [clay, ...args], { cwd: dir });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stdin.end(answer);
    const [code] = await once(child, 'exit');

    return { code: code as number | null, stdout: stripVTControlCharacters(stdout) };
  };

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
});
