import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { start } from './start';

describe('a map spelled like the unknown marker', () => {
  let dir: string;

  const newOrchestrator = () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    return engine;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-unknown-lookalike-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('is applied once and then planned as unchanged, like any other value', async () => {
    const config = 'resource "null_resource" "a" { triggers = { "@@clay/unknown" = true } }';
    for await (const event of start(newOrchestrator(), config)) if (event.type === 'failed') throw event.error;

    const { actions } = await newOrchestrator().plan(config);

    expect(actions.map((action) => action.type)).toEqual(['NO_OP']);
  });
});
