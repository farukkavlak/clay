import { emptyState } from '@clay/contracts';
import { serializeState } from '@clay/state';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
});
