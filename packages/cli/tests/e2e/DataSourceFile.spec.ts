import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { CONFIG_FILE } from '@clay/parser';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('a local_file data source', () => {
  let dir: string;

  const newOrchestrator = () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    return engine;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-data-file-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  // A resource of the same type wants content to write; a data source only reads.
  it('reads the content of a file, given only its path', async () => {
    await fs.writeFile(path.join(dir, 'name.txt'), 'clay', 'utf8');
    const config = `
      data "local_file" "name" { path = "${path.join(dir, 'name.txt')}" }
      output "greeting" { value = "hello \${data.local_file.name.content}" }
    `;

    const { outputs } = await newOrchestrator().plan(config);

    expect(outputs.greeting.new).toBe('hello clay');
  });

  it('refuses a file that is not there, placed in its block', async () => {
    const missing = path.join(dir, 'missing.txt');

    await expect(newOrchestrator().plan(`data "local_file" "f" { path = "${missing}" }`)).rejects.toMatchObject({
      message: `local_file cannot read "${missing}": there is no such file`,
      block: 'data "local_file" "f"',
      position: { file: CONFIG_FILE, line: 1, column: 1 },
    });
  });

  it('refuses a type the provider makes as a resource but does not read as a data source', async () => {
    await expect(newOrchestrator().plan('data "random_string" "r" { length = 4 }')).rejects.toMatchObject({
      message: 'No provider reads data source "random_string"',
      block: 'data "random_string" "r"',
      position: { file: CONFIG_FILE, line: 1, column: 1 },
    });
  });
});
