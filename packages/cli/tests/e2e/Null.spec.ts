import { types } from '@clay/contracts';
import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { ConfigError } from '@clay/parser';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { start } from './start';

describe('null', () => {
  let dir: string;

  const newOrchestrator = () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    return engine;
  };

  const apply = async (config: string) => {
    for await (const event of start(newOrchestrator(), config)) if (event.type === 'failed') throw event.error;
  };

  const planError = async (config: string): Promise<ConfigError> => {
    try {
      await newOrchestrator().plan(config);
    } catch (error) {
      if (error instanceof ConfigError) return error;

      throw error;
    }

    throw new Error('the plan was made');
  };

  const attributes = async (address: string) => {
    const { resources } = await new LocalBackend(dir).read();
    return resources[address].attributes;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-null-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('leaves out an attribute set to null, and plans nothing after', async () => {
    const config = 'resource "null_resource" "n" { triggers = null }';
    await apply(config);

    expect(Object.keys(await attributes('null_resource.n'))).toEqual(['id']);
    const { actions } = await newOrchestrator().plan(config);
    expect(actions.map((action) => action.type)).toEqual(['NO_OP']);
  });

  // Left out like any other, so the provider makes it as if nothing were written.
  it('takes null for an attribute only the provider makes', async () => {
    await apply('resource "random_string" "r" {\n  length = 4\n  result = null\n}');

    const { result } = await attributes('random_string.r');
    expect(result).toHaveLength(4);
  });

  // Set to null is left out, so the two read the same: before the resource is made, and from state after.
  it('reads an attribute set to null, or left out, as null', async () => {
    const config = `resource "null_resource" "a" { triggers = null }\nresource "null_resource" "b" {}
      output "set" { value = null_resource.a.triggers }\noutput "left" { value = null_resource.b.triggers }`;
    await apply(config);

    const state = await new LocalBackend(dir).read();
    const none = { value: null, type: types.map(types.dynamic) };
    expect(state.outputs).toEqual({ set: none, left: none });
    const plan = await newOrchestrator().plan(config);
    expect(plan.outputs).toEqual({});
  });

  it('leaves out an attribute a variable sets to null', async () => {
    await apply('variable "t" { default = null }\nresource "null_resource" "n" { triggers = var.t }');

    expect(Object.keys(await attributes('null_resource.n'))).toEqual(['id']);
  });

  it('refuses null for an attribute the resource requires, where it is written', async () => {
    const error = await planError(`resource "local_file" "f" {\n  path = null\n  content = "x"\n}`);

    expect(error.message).toBe('local_file requires "path"');
    expect(error.position).toMatchObject({ line: 2, column: 10 });
  });

  it('keeps null inside a map', async () => {
    await apply('resource "null_resource" "n" { triggers = { a = null, b = "x" } }');

    const { triggers } = await attributes('null_resource.n');
    expect(triggers).toEqual({ a: null, b: 'x' });
  });

  it('takes null as a module input', async () => {
    await fs.mkdir(path.join(dir, 'm'));
    await fs.writeFile(path.join(dir, 'm', 'main.clay'), 'variable "text" {}\nresource "null_resource" "n" { triggers = { t = var.text } }', 'utf8');

    await apply('module "m" {\n  source = "./m"\n  text = null\n}');

    const { triggers } = await attributes('module.m.null_resource.n');
    expect(triggers).toEqual({ t: null });
  });

  it('writes an output of null to state', async () => {
    await apply('output "o" { value = null }');

    const { outputs } = await new LocalBackend(dir).read();
    expect(outputs).toEqual({ o: { value: null, type: types.dynamic } });
  });

  it.each([
    ['a read into it', 'content = var.x.y', 'var.x is null and cannot be read into'],
    ['a string it is joined into', 'content = "a ${var.x}"', 'var.x is null and cannot be joined into a string'],
  ])('refuses %s, where it is written', async (_, content, message) => {
    const error = await planError(`variable "x" { default = null }\nresource "local_file" "f" {\n  path = "f.txt"\n  ${content}\n}`);

    expect(error.message).toBe(message);
    expect(error.position).toMatchObject({ line: 4 });
  });

  it.each([
    ['count', 'count is a whole number from 0, not null'],
    ['for_each', 'for_each is a map, or a list or a set of strings, not null'],
  ])('refuses null as %s', async (argument, message) => {
    const error = await planError(`resource "null_resource" "n" {\n  ${argument} = null\n}`);

    expect(error.message).toBe(message);
    expect(error.position).toMatchObject({ line: 2 });
  });
});
