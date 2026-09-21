import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const echoModule = `variable "text" {}\noutput "echo" { value = "\${var.text}" }`;

describe('what plan refuses before anything runs', () => {
  let dir: string;

  const newOrchestrator = () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    return engine;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-plan-checks-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("a value the provider will not take, named by its resource, with the provider's error as the cause", async () => {
    const config = 'resource "random_string" "pw" { length = "8" }';
    const refused = 'random_string requires "length" attribute (number > 0)';

    await expect(newOrchestrator().plan(config)).rejects.toMatchObject({ message: `random_string.pw: ${refused}`, cause: { message: refused } });
  });

  it('a resource type no provider handles', async () => {
    const config = 'resource "aws_bucket" "b" { name = "x" }';

    await expect(newOrchestrator().plan(config)).rejects.toThrow('No provider handles "aws_bucket"');
  });

  it('a variable with no default and no value, whether or not anything reads it', async () => {
    const config = 'variable "unused" {}';

    await expect(newOrchestrator().plan(config)).rejects.toThrow('variable "unused" has no value');
  });

  it('a module called without one of its inputs, naming the module', async () => {
    await fs.mkdir(path.join(dir, 'm'));
    await fs.writeFile(path.join(dir, 'm', 'main.clay'), echoModule, 'utf8');
    const config = 'module "m" { source = "./m" }';

    await expect(newOrchestrator().plan(config)).rejects.toThrow('module.m: variable "text" has no value');
  });

  it('nothing about a module input that the caller gives', async () => {
    await fs.mkdir(path.join(dir, 'm'));
    await fs.writeFile(path.join(dir, 'm', 'main.clay'), echoModule, 'utf8');
    const config = `module "m" { source = "./m" text = "given" }\noutput "echo" { value = "\${module.m.echo}" }`;

    const plan = await newOrchestrator().plan(config);

    expect(plan.outputs).toEqual({ echo: { old: undefined, new: 'given' } });
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
