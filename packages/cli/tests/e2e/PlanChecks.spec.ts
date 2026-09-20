import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('what plan refuses before anything runs', () => {
  let dir: string;

  const newOrchestrator = () => {
    const engine = new Orchestrator(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    return engine;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-plan-checks-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('a value the provider will not take, named by its resource', async () => {
    const config = 'resource "random_string" "pw" { length = "8" }';

    await expect(newOrchestrator().plan(config)).rejects.toThrow('random_string.pw: random_string requires "length" attribute (number > 0)');
  });

  it('a resource type no provider handles', async () => {
    const config = 'resource "aws_bucket" "b" { name = "x" }';

    await expect(newOrchestrator().plan(config)).rejects.toThrow('No provider handles "aws_bucket"');
  });

  it('nothing about a value that is not known yet', async () => {
    const config = `
      resource "random_string" "pw" { length = 8 }
      resource "local_file" "f" {
        path = "${path.join(dir, 'a.txt')}"
        content = "\${random_string.pw.id}"
      }
    `;

    const plan = await newOrchestrator().plan(config);

    expect(plan.actions.map((action) => action.type)).toEqual(['CREATE', 'CREATE']);
  });
});
