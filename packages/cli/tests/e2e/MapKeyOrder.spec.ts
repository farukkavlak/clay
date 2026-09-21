import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { start } from './start';

const withTriggers = (triggers: string) => `resource "null_resource" "a" { triggers = ${triggers} }`;

describe('a map attribute whose keys are written in another order', () => {
  let dir: string;

  const newOrchestrator = () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    return engine;
  };

  const apply = async (config: string) => {
    for await (const event of start(newOrchestrator(), config)) if (event.type === 'failed') throw event.error;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-map-order-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  // State holds the keys in the order they were first written, so a plan against a reordered config used to show an update that never settled.
  it('plans nothing, having gone through a real apply and a state file', async () => {
    await apply(withTriggers('{ a = "1" b = "2" }'));

    const planned = await newOrchestrator().plan(withTriggers('{ b = "2" a = "1" }'));

    expect(planned.actions.map((action) => action.type)).toEqual(['NO_OP']);
  });
});
