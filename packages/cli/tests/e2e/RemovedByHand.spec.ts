import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { start } from './start';

describe('a file removed by hand', () => {
  let dir: string;

  const run = async (config: string) => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    for await (const event of start(engine, config)) if (event.type === 'failed') throw event.error;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-removed-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('is destroyed without a fuss once the configuration drops it', async () => {
    const file = path.join(dir, 'a.txt');
    await run(`resource "local_file" "a" { path = "${file}" content = "hi" }`);
    await fs.rm(file);

    await run('');

    const state = await new LocalBackend(dir).read();
    expect(state.resources).toEqual({});
  });
});
