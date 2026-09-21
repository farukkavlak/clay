import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { start } from './start';

describe('a module with more than one output', () => {
  let dir: string;

  const newOrchestrator = () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    return engine;
  };

  const applied = async (config: string) => {
    for await (const event of start(newOrchestrator(), config)) if (event.type === 'failed') throw event.error;

    const state = await new LocalBackend(dir).read();

    return state.resources;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-module-outputs-'));
    await fs.mkdir(path.join(dir, 'm'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  // `early` is ready in the first layer; `late` waits for the module input that a root resource feeds.
  it('runs when one output is ready long before another', async () => {
    await fs.writeFile(
      path.join(dir, 'm', 'main.clay'),
      `
      variable "text" { default = "" }
      resource "local_file" "early" { path = "${path.join(dir, 'early.txt')}" content = "early" }
      resource "local_file" "late" { path = "${path.join(dir, 'late.txt')}" content = "\${var.text}" }
      output "early_content" { value = "\${local_file.early.content}" }
      output "late_content" { value = "\${local_file.late.content}" }
    `,
      'utf8'
    );
    const config = `
      resource "local_file" "root" { path = "${path.join(dir, 'root.txt')}" content = "root" }
      module "m" { source = "./m" text = "\${local_file.root.content}" }
    `;

    const resources = await applied(config);

    expect(Object.keys(resources).sort()).toEqual(['local_file.root', 'module.m.local_file.early', 'module.m.local_file.late']);
    expect(await fs.readFile(path.join(dir, 'late.txt'), 'utf8')).toBe('root');
  });
});
