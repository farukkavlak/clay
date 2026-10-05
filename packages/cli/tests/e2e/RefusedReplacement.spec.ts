import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { start } from './start';

describe('a replacement its provider refuses at apply', () => {
  let dir: string;

  const run = async (config: string) => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    for await (const event of start(engine, config)) if (event.type === 'failed') throw event.error;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-refused-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  // The new length is unknown at plan; at apply it resolves to an id that is not a number.
  it('leaves the old resource in state', async () => {
    await run('resource "random_string" "a" { length = 4 }');
    const before = await new LocalBackend(dir).read();

    await expect(
      run(`
        resource "null_resource" "n" {}
        resource "random_string" "a" { length = null_resource.n.id }
      `)
    ).rejects.toThrow(/^length: "[0-9a-f-]+" is not a number$/);

    const after = await new LocalBackend(dir).read();
    expect(after.resources['random_string.a']).toEqual(before.resources['random_string.a']);
  });
});
