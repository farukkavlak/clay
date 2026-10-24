import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { ConfigError } from '@clay/parser';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Where an error would point at the first `needle`. */
const placeOf = (config: string, needle: string) => {
  const before = config.slice(0, config.indexOf(needle)).split('\n');
  return { line: before.length, column: before.at(-1)!.length + 1 };
};

const CALL = 'module "m" {\n  source = "./m"\n  count  = 0\n}';

const rule = (condition: string, message: string) =>
  `variable "p" {\n  type    = number\n  default = 1\n  validation {\n    condition     = ${condition}\n    error_message = ${message}\n  }\n}`;

// Nothing in the module is read for an instance, so only the read as written reaches these.
describe('a module called with count = 0', () => {
  let dir: string;

  const newOrchestrator = () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    return engine;
  };

  const module = async (content: string, inner = '') => {
    await fs.mkdir(path.join(dir, 'm', 'n'), { recursive: true });
    await fs.writeFile(path.join(dir, 'm', 'n', 'main.clay'), inner);
    await fs.writeFile(path.join(dir, 'm', 'main.clay'), content);
  };

  async function planError(): Promise<ConfigError> {
    try {
      await newOrchestrator().plan(CALL);
    } catch (error) {
      if (error instanceof ConfigError) return error;

      throw error;
    }

    throw new Error('Expected the plan to fail');
  }

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-no-instances-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it.each([
    ['a resource count that is no number', 'resource "random_string" "s" {\n  count  = "abc"\n  length = 4\n}', '"abc"', 'count is a whole number from 0, not a string'],
    ['a data source count that is no number', 'data "local_file" "f" {\n  count = true\n  path  = "x"\n}', 'true', 'count is a whole number from 0, not a boolean'],
    ['a module call count that is no number', 'module "n" {\n  source = "./n"\n  count  = "abc"\n}', '"abc"', 'count is a whole number from 0, not a string'],
    [
      'a for_each that is no collection',
      'resource "random_string" "s" {\n  for_each = 5\n  length   = 4\n}',
      '5\n',
      'for_each is a map, or a list or a set of strings, not a number',
    ],
    [
      'a sensitive count',
      'resource "random_string" "s" {\n  count  = sensitive(1)\n  length = 4\n}',
      'sensitive(1)',
      'count is sensitive: the number of instances shows what it is',
    ],
    [
      'a sensitive count not known yet',
      'variable "n" {\n  type    = number\n  default = 1\n}\nresource "random_string" "s" {\n  count  = sensitive(var.n)\n  length = 4\n}',
      'sensitive(var.n)',
      'count is sensitive: the number of instances shows what it is',
    ],
    [
      'a sensitive for_each with a part not known yet',
      'variable "x" {\n  type    = string\n  default = "a"\n}\nresource "random_string" "s" {\n  for_each = sensitive({ a = var.x })\n  length   = 4\n}',
      'sensitive({',
      'for_each is sensitive: a key shows in an address, so it cannot be hidden',
    ],
    [
      'a count from a variable written sensitive',
      'variable "n" {\n  type      = number\n  default   = 1\n  sensitive = true\n}\nresource "random_string" "s" {\n  count  = var.n\n  length = 4\n}',
      'var.n\n',
      'count is sensitive: the number of instances shows what it is',
    ],
    ['a resource the provider refuses', 'resource "local_file" "f" {\n  path    = ""\n  content = "x"\n}', 'resource "local_file"', 'local_file "path" must not be empty'],
    ['a data source the provider refuses', 'data "local_file" "f" {\n  path = ""\n}', 'data "local_file"', 'local_file "path" must not be empty'],
    [
      'a resource the provider refuses, where a sensitive value is given',
      'resource "local_file" "f" {\n  path    = sensitive("")\n  content = "x"\n}',
      'resource "local_file"',
      'local_file failed on its configuration; a value given to it is sensitive, so the reason is not shown',
    ],
    ["a rule's condition that is no boolean", rule('var.p + 1', '"x"'), 'var.p + 1', "A validation's condition takes a boolean, not a number"],
    ["a rule's message that is no string", rule('var.p > 0', '5'), '5\n', "A validation's error_message is a string, not a number"],
    ["a rule's message not known yet that is no string", rule('var.p > 0', 'var.p'), 'var.p\n', "A validation's error_message is a string, not a number"],
    ["a rule's message that is a list with a part not known yet", rule('var.p > 0', '[var.p]'), '[var.p]', "A validation's error_message is a string, not a tuple"],
    [
      'a key two attributes of an object give, one of them optional',
      'variable "o" {\n  type = object({ a = string, b = optional(string) })\n  default = { a = "1" }\n}\noutput "x" {\n  value = { for k, v in var.o : "k" => v }\n}',
      '"k" =>',
      'Two items give the key "k"; write "..." after the value to group them',
    ],
  ])('refuses %s, where the module writes it', async (_, content, needle, message) => {
    await module(content);

    const error = await planError();

    expect(error.message).toBe(message);
    expect(error.position).toMatchObject({ file: path.join('m', 'main.clay'), ...placeOf(content, needle) });
  });

  it('refuses a count from an output its own module writes sensitive', async () => {
    const content = 'module "n" {\n  source = "./n"\n}\nresource "random_string" "s" {\n  count  = module.n.size\n  length = 4\n}';
    await module(content, 'output "size" {\n  value     = 1\n  sensitive = true\n}');

    const error = await planError();

    expect(error.message).toBe('count is sensitive: the number of instances shows what it is');
    expect(error.position).toMatchObject({ file: path.join('m', 'main.clay'), ...placeOf(content, 'module.n.size') });
  });

  it.each([
    [
      'a count sensitive only on a branch an instance may not take',
      'variable "b" {\n  type    = bool\n  default = false\n}\nresource "random_string" "s" {\n  count  = var.b ? sensitive(1) : 2\n  length = 4\n}',
    ],
    [
      'a resource whose value the provider checks is known only for an instance',
      'variable "n" {\n  type    = number\n  default = 4\n}\nresource "random_string" "s" {\n  length = var.n - 5\n}',
    ],
    ['a rule whose condition and message are known only for an instance', rule('var.p > 0', '"p is ${var.p}"')],
    [
      'a for_each with a key sensitive only on a branch an instance may not take',
      'variable "b" {\n  type    = bool\n  default = false\n}\nresource "random_string" "s" {\n  for_each = [var.b ? sensitive("a") : "b"]\n  length   = 4\n}',
    ],
    [
      'a for_each known only for an instance',
      'variable "names" {\n  type    = set(string)\n  default = []\n}\nresource "random_string" "s" {\n  for_each = var.names\n  length   = 4\n}',
    ],
  ])('takes %s', async (_, content) => {
    await module(content);

    const plan = await newOrchestrator().plan(CALL);

    expect(plan.actions).toEqual([]);
  });
});

describe('a block with no instance at the root', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-no-instances-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function planError(config: string): Promise<ConfigError> {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());

    try {
      await engine.plan(config);
    } catch (error) {
      if (error instanceof ConfigError) return error;

      throw error;
    }

    throw new Error('Expected the plan to fail');
  }

  it.each([
    ['a count of 0', 'resource "random_string" "s" {\n  count  = 0\n  length = -1\n}', 'random_string requires "length" attribute (number > 0)'],
    ['an empty for_each', 'resource "random_string" "s" {\n  for_each = {}\n  length   = -1\n}', 'random_string requires "length" attribute (number > 0)'],
    ['a data source with a count of 0', 'data "local_file" "f" {\n  count = 0\n  path  = ""\n}', 'local_file "path" must not be empty'],
  ])('is refused where the provider refuses it, with %s', async (_, config, message) => {
    const error = await planError(config);

    expect(error.message).toBe(message);
    expect(error.position).toMatchObject({ line: 1, column: 1 });
  });

  it('gives the provider no attribute set to null', async () => {
    const provider = new LocalProvider();
    const validate = vi.spyOn(provider, 'validate');
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(provider);

    await engine.plan('resource "null_resource" "n" {\n  count    = 0\n  triggers = null\n}');

    expect(validate.mock.calls).toEqual([['null_resource', {}]]);
  });
});
