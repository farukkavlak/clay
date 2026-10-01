import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { start } from './start';

const LOST = 'the state holds no id, which command_exec keeps until the resource is replaced. Restore the state from its backup, or remove the resource with clay state rm';

describe('a state that lost a value its provider keeps', () => {
  let dir: string;

  const newOrchestrator = () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    return engine;
  };

  const appending = (line: string) => `resource "command_exec" "c" {\n  command = "echo ${line} >> ran.txt"\n  cwd = "${dir}"\n}`;

  const loseId = async () => {
    const backend = new LocalBackend(dir);
    const state = await backend.read();
    delete state.resources['command_exec.c'].attributes.id;
    await backend.write(state);
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-lost-'));
    for await (const event of start(newOrchestrator(), appending('1'))) if (event.type === 'failed') throw event.error;
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('refuses to plan a change in place, where the resource is written', async () => {
    await loseId();

    await expect(newOrchestrator().plan(appending('2'))).rejects.toMatchObject({
      message: LOST,
      position: { file: 'main.clay', line: 1, column: 1 },
      block: 'resource "command_exec" "c"',
    });
  });

  it('runs nothing when applied', async () => {
    await loseId();

    await expect(start(newOrchestrator(), appending('2')).next()).rejects.toThrow(LOST);
    expect(await fs.readFile(path.join(dir, 'ran.txt'), 'utf8')).toBe('1\n');
  });
});
