import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { start } from './start';

describe('a reference to a name every object has', () => {
  let dir: string;

  const newOrchestrator = () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    return engine;
  };

  const run = async (config: string) => {
    for await (const event of start(newOrchestrator(), config)) if (event.type === 'failed') throw event.error;
  };

  const fileA = () => `resource "local_file" "a" { path = "${path.join(dir, 'a.txt')}" content = "a" }`;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-inherited-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  // It used to resolve to `Object.prototype.toString`, and the provider complained about the content instead.
  it('says the attribute is not there, rather than handing a function to the provider', async () => {
    await run(fileA());
    const reads = `${fileA()}\nresource "local_file" "b" { path = "${path.join(dir, 'b.txt')}" content = "\${local_file.a.toString}" }`;

    await expect(run(reads)).rejects.toThrow('Invalid resource reference "local_file.a.toString": Attribute "toString" not found on resource');
    await expect(fs.access(path.join(dir, 'b.txt'))).rejects.toThrow();
  });
});
