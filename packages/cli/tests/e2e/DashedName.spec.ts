import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { start } from './start';

describe('a name with a dash in it', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-dashed-name-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  // The name is written in one file and read back by the reference, the state key and the address a command takes.
  it('is applied, read by another resource and addressed in state', async () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    const config = `
      resource "local_file" "a-b" { path = "${path.join(dir, 'a-b.txt')}" content = "first" }
      resource "local_file" "c" { path = "${path.join(dir, 'c.txt')}" content = local_file.a-b.content }
    `;

    for await (const event of start(engine, config)) if (event.type === 'failed') throw event.error;

    const state = await new LocalBackend(dir).read();

    expect(Object.keys(state.resources).sort()).toEqual(['local_file.a-b', 'local_file.c']);
    expect(await fs.readFile(path.join(dir, 'c.txt'), 'utf8')).toBe('first');
  });
});
