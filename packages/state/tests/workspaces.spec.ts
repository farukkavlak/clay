import { emptyState } from '@clay/core';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalBackend } from '../src/backends/LocalBackend';
import { checkWorkspaceName, currentWorkspace, givenWorkspace, namedWorkspace, selectedWorkspace, selectWorkspace, workspaceBackend } from '../src/backends/workspaces';
import { backendAt } from './backendAt';

describe('a workspace name', () => {
  it.each(['dev', 'a', '0', 'pr-12', 'a'.repeat(63)])('takes %s', (name) => {
    expect(checkWorkspaceName(name, 'here')).toBe(name);
  });

  it.each(['', 'Dev', 'a_b', '-a', 'a-', '..', 'a/b', 'a.b', ' a', 'a\n', 'a'.repeat(64)])('refuses %j, naming where it came from', (name) => {
    expect(() => checkWorkspaceName(name, 'the file')).toThrow(`Workspace name ${JSON.stringify(name)} in the file is not valid`);
  });

  it('says what a name may hold', () => {
    expect(() => checkWorkspaceName('A', 'here')).toThrow('use lowercase letters, digits and "-", 1 to 63 characters, starting and ending with a letter or digit');
  });
});

describe('the selected workspace', () => {
  let dir: string;

  const select = async (content: string) => {
    await fs.mkdir(path.join(dir, '.clay'), { recursive: true });
    await fs.writeFile(path.join(dir, '.clay', 'workspace'), content, 'utf8');
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-workspaces-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('is the default one where no file selects one', () => {
    expect(selectedWorkspace(dir)).toBe('default');
  });

  it('is the one the file names', async () => {
    await select('dev');

    expect(selectedWorkspace(dir)).toBe('dev');
  });

  it.each(['dev\n', 'dev\r\n'])('is read without the line break that ends the file (%j)', async (content) => {
    await select(content);

    expect(selectedWorkspace(dir)).toBe('dev');
  });

  it('is refused where the file names no valid workspace, naming the file', async () => {
    await select('dev\n\n');

    expect(() => selectedWorkspace(dir)).toThrow(`Workspace name "dev\\n" in ${path.join(dir, '.clay', 'workspace')} is not valid`);
  });

  it('is the one last selected, in a .clay folder made for it', async () => {
    await selectWorkspace(dir, 'dev');
    await selectWorkspace(dir, 'test');

    expect(selectedWorkspace(dir)).toBe('test');
    await expect(fs.readdir(path.join(dir, '.clay'))).resolves.toEqual(['workspace']);
  });

  it('is one whole name where two are selected at once', async () => {
    for (let round = 0; round < 50; round++) await Promise.all([selectWorkspace(dir, 'dev'), selectWorkspace(dir, 'test')]);

    expect(['dev', 'test']).toContain(selectedWorkspace(dir));
    await expect(fs.readdir(path.join(dir, '.clay'))).resolves.toEqual(['workspace']);
  });

  it('leaves nothing beside the file where it cannot be replaced', async () => {
    await fs.mkdir(path.join(dir, '.clay', 'workspace', 'inside'), { recursive: true });

    await expect(selectWorkspace(dir, 'dev')).rejects.toThrow('EISDIR');
    await expect(fs.readdir(path.join(dir, '.clay'))).resolves.toEqual(['workspace']);
  });

  it('is not guessed where the file cannot be read', async () => {
    await fs.mkdir(path.join(dir, '.clay', 'workspace'), { recursive: true });

    expect(() => selectedWorkspace(dir)).toThrow('EISDIR');
  });
});

describe('the workspace of a command', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-workspaces-'));
    await selectWorkspace(dir, 'selected');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('is the one CLAY_WORKSPACE names, over the selected one', () => {
    expect(currentWorkspace(dir, { CLAY_WORKSPACE: 'given' })).toBe('given');
  });

  it.each([[{}], [{ CLAY_WORKSPACE: '' }]])('is the selected one where %j names none', (env) => {
    expect(currentWorkspace(dir, env)).toBe('selected');
    expect(givenWorkspace(env)).toBeUndefined();
  });

  it('is refused where CLAY_WORKSPACE names no valid workspace, naming the variable', () => {
    expect(() => givenWorkspace({ CLAY_WORKSPACE: 'a/b' })).toThrow('Workspace name "a/b" in CLAY_WORKSPACE is not valid');
  });
});

describe('the backend of a workspace', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-workspaces-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('is the backend itself for the default workspace, with no state written yet', async () => {
    const backend = new LocalBackend(dir);

    await expect(workspaceBackend(backend, 'default')).resolves.toBe(backend);
  });

  it('is the state of a named workspace that exists', async () => {
    const named = new LocalBackend(dir).workspace('dev');
    await fs.mkdir(path.dirname(named.location), { recursive: true });
    await named.write({ ...emptyState(), lineage: 'lineage' });

    const found = await workspaceBackend(new LocalBackend(dir), 'dev');

    expect(found.location).toBe(named.location);
  });

  it('is refused for a named workspace with no state, rather than started empty', async () => {
    await new LocalBackend(dir).write({ ...emptyState(), lineage: 'lineage' });

    await expect(workspaceBackend(new LocalBackend(dir), 'dev')).rejects.toThrow('Workspace "dev" does not exist; run `clay workspace new dev` to make it');
  });

  it('is refused for a named workspace where the backend keeps one state', async () => {
    const backend = backendAt('http://127.0.0.1:1');

    await expect(workspaceBackend(backend, 'dev')).rejects.toThrow('Backend "http" keeps one state, so workspace "dev" cannot be used');
  });

  it('is built for a named workspace with no state yet, which a new one is', () => {
    expect(namedWorkspace(new LocalBackend(dir), 'dev').location).toBe(path.join(dir, 'clay.workspaces', 'dev', 'clay.state.json'));
  });

  it('is refused for a new workspace where the backend keeps one state', () => {
    expect(() => namedWorkspace(backendAt('http://127.0.0.1:1'), 'dev')).toThrow('Backend "http" keeps one state, so workspace "dev" cannot be used');
  });
});
