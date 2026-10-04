import { types } from '@clay/contracts';
import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { CONFIG_FILE } from '@clay/parser';
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

  it("a value the provider will not take, placed in its block, with the provider's error as the cause", async () => {
    const config = 'resource "random_string" "pw" { length = 0 }';
    const refused = 'random_string requires "length" attribute (number > 0)';

    await expect(newOrchestrator().plan(config)).rejects.toMatchObject({
      message: refused,
      block: 'resource "random_string" "pw"',
      position: { file: CONFIG_FILE, line: 1, column: 1 },
      cause: { message: refused },
    });
  });

  it.each([
    ['a resource type', 'resource "aws_bucket" "b" { name = "x" }', 'resource "aws_bucket" "b"', 'No provider handles "aws_bucket"'],
    ['a data source type', 'data "aws_bucket" "b" { name = "x" }', 'data "aws_bucket" "b"', 'No provider reads data source "aws_bucket"'],
  ])('%s no provider handles, placed in its block', async (_, config, block, message) => {
    await expect(newOrchestrator().plan(config)).rejects.toMatchObject({
      message,
      block,
      position: { file: CONFIG_FILE, line: 1, column: 1 },
    });
  });

  // Which values a provider computes is read before any value is resolved, so a type no provider handles is refused first.
  it('a resource type no provider handles, before a value in it that does not resolve', async () => {
    const config = 'variable "v" { default = "s" }\nresource "aws_bucket" "b" { name = var.v.x }';

    await expect(newOrchestrator().plan(config)).rejects.toThrow('No provider handles "aws_bucket"');
  });

  it('a data source the provider refuses, placed in its block', async () => {
    const config = 'data "local_file" "f" { path = "" }';

    await expect(newOrchestrator().plan(config)).rejects.toMatchObject({
      message: 'local_file "path" must not be empty',
      block: 'data "local_file" "f"',
      position: { file: CONFIG_FILE, line: 1, column: 1 },
    });
  });

  it('a variable with no default and no value, whether or not anything reads it', async () => {
    const config = 'variable "unused" {}';

    await expect(newOrchestrator().plan(config)).rejects.toMatchObject({
      message: 'variable "unused" has no value',
      position: { file: 'main.clay', line: 1, column: 1 },
      block: 'variable "unused"',
    });
  });

  it('a module called without one of its inputs, naming the module', async () => {
    await fs.mkdir(path.join(dir, 'm'));
    await fs.writeFile(path.join(dir, 'm', 'main.clay'), echoModule, 'utf8');
    const config = 'module "m" { source = "./m" }';

    await expect(newOrchestrator().plan(config)).rejects.toMatchObject({
      message: 'variable "text" has no value',
      position: { file: 'm/main.clay', line: 1, column: 1 },
      block: 'variable "text"',
      module: 'module.m',
    });
  });

  it('nothing about a module input that the caller gives', async () => {
    await fs.mkdir(path.join(dir, 'm'));
    await fs.writeFile(path.join(dir, 'm', 'main.clay'), echoModule, 'utf8');
    const config = `module "m" { source = "./m" text = "given" }\noutput "echo" { value = "\${module.m.echo}" }`;

    const plan = await newOrchestrator().plan(config);

    expect(plan.outputs).toEqual({ echo: { old: undefined, new: { value: 'given', type: types.string } } });
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

  it('a value the provider will not take, beside one that is not known yet', async () => {
    const config = `
      resource "random_string" "pw" { length = 8 }
      resource "local_file" "f" {
        path = ""
        content = "\${random_string.pw.id}"
      }
    `;

    await expect(newOrchestrator().plan(config)).rejects.toMatchObject({
      message: 'local_file "path" must not be empty',
      block: 'resource "local_file" "f"',
    });
  });
});
