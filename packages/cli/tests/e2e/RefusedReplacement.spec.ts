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

  // The new path is not known at plan, so the values are first checked at apply, where the content is a number.
  it('leaves the old file on disk and in state', async () => {
    const file = path.join(dir, 'a.txt');
    await run(`resource "local_file" "a" { path = "${file}" content = "hi" }`);

    await expect(
      run(`
        resource "random_string" "n" { length = 4 }
        resource "local_file" "a" {
          path    = "${dir}/\${random_string.n.result}.txt"
          content = random_string.n.length
        }
      `)
    ).rejects.toThrow('content is a number, where local_file takes a string');

    expect(await fs.readFile(file, 'utf8')).toBe('hi');
    const state = await new LocalBackend(dir).read();
    expect(state.resources['local_file.a']).toMatchObject({ attributes: { path: file, content: 'hi' } });
  });
});
