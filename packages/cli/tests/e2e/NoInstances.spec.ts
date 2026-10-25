import { planFromSchema, PlannedChange, PlanRequest, Provider, Schema, types } from '@clay/contracts';
import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { ConfigError } from '@clay/parser';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TAGGED: Schema = { tags: { type: types.set(types.string), required: true } };

/** A resource that holds what it is given as a set; it is only planned. */
class Tagger implements Provider {
  readonly resources = ['tagged'];
  readonly dataSources: string[] = [];

  async getSchema(): Promise<Schema> {
    return TAGGED;
  }

  async plan(_type: string, request: PlanRequest): Promise<PlannedChange> {
    return planFromSchema(TAGGED, request);
  }

  async validate(): Promise<void> {}

  async read(_type: string, prior: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    return prior;
  }

  async create(): Promise<Record<string, unknown>> {
    return {};
  }

  async update(): Promise<Record<string, unknown>> {
    return {};
  }

  async delete(): Promise<void> {}

  async getDataSourceSchema(): Promise<Schema> {
    return {};
  }

  async validateDataSource(): Promise<void> {}

  async readDataSource(): Promise<Record<string, unknown>> {
    return {};
  }
}

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
    engine.registerProvider(new Tagger());
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

  const COUNTED = 'resource "random_string" "s" {\n  count  = %s\n  length = 4\n}';
  const counted = (count: string, before: string) => `${before}\n${COUNTED.replace('%s', count)}`;
  const CALLED = 'module "n" {\n  source = "./n"\n}';
  const CALLED_ONCE = 'module "n" {\n  source = "./n"\n  count  = 1\n}';
  const FILE = 'resource "local_file" "f" {\n  path    = "f"\n  content = sensitive("abc")\n}';
  const FILES = 'resource "local_file" "f" {\n  count   = 1\n  path    = "f"\n  content = sensitive("abc")\n}';

  it.each([
    ['an output its own module writes sensitive', CALLED, 'output "size" {\n  value     = 1\n  sensitive = true\n}', 'module.n.size'],
    ['the sensitive value of an output', CALLED, 'output "size" { value = sensitive(1) }', 'module.n.size'],
    [
      'an output whose value a set it is held in makes sensitive as a whole',
      CALLED,
      'output "size" {\n  type  = set(string)\n  value = [sensitive("a"), "b"]\n}',
      'length(module.n.size)',
    ],
    ['the sensitive value of an output, read with every other', `${CALLED}\nlocals {\n  n = module.n\n}`, 'output "size" { value = sensitive(1) }', 'local.n.size'],
    ['the sensitive value of an output, in an instance of the call', CALLED_ONCE, 'output "size" { value = sensitive(1) }', 'module.n[0].size'],
    [
      'the sensitive value of an output, read with every instance of the call',
      `${CALLED_ONCE}\nlocals {\n  n = module.n\n}`,
      'output "size" { value = sensitive(1) }',
      'local.n[0].size',
    ],
    ['a sensitive value a resource is given', FILE, '', 'length(local_file.f.content)'],
    ['a sensitive value a resource is given, read with every other', `${FILE}\nlocals {\n  f = local_file.f\n}`, '', 'length(local.f.content)'],
    ['a sensitive value an instance of a resource is given', FILES, '', 'length(local_file.f[0].content)'],
    ['a sensitive value a resource is given, read with every instance', `${FILES}\nlocals {\n  f = local_file.f\n}`, '', 'length(local.f[0].content)'],
    [
      'a value a resource holds as a set, which a sensitive item makes sensitive as a whole',
      'resource "tagged" "t" {\n  tags = [sensitive("a"), "b"]\n}',
      '',
      'length(tagged.t.tags)',
    ],
    ['a sensitive value a data source is given', 'data "local_file" "f" {\n  path = sensitive("f")\n}', '', 'length(data.local_file.f.path)'],
  ])('refuses a count from %s', async (_, before, inner, count) => {
    const content = counted(count, before);
    await module(content, inner);

    const error = await planError();

    expect(error.message).toBe('count is sensitive: the number of instances shows what it is');
    expect(error.position).toMatchObject({ file: path.join('m', 'main.clay'), ...placeOf(content, count) });
  });

  it('refuses a mistake in the value of an output a count reads at the output', async () => {
    const inner = 'output "size" { value = !"a" }';
    await module(counted('module.n.size', CALLED), inner);

    const error = await planError();

    expect(error.message).toBe('! takes a boolean, not a string');
    expect([error.block, error.module]).toEqual(['output "size"', 'module.m.module.n']);
    expect(error.position).toMatchObject({ file: path.join('m', 'n', 'main.clay'), ...placeOf(inner, '"a"') });
  });

  it.each([
    [
      'the value of an output sensitive only on a branch an instance may not take',
      CALLED,
      'variable "b" {\n  default = false\n}\noutput "size" { value = var.b ? sensitive(1) : 2 }',
      'module.n.size',
    ],
    [
      'an output beside one whose value is sensitive',
      `${CALLED}\nlocals {\n  n = module.n\n}`,
      'output "size" { value = sensitive(1) }\noutput "name" { value = "n" }',
      'length(local.n.name)',
    ],
    [
      'an output beside one whose value is sensitive, in an instance of the call',
      `${CALLED_ONCE}\nlocals {\n  n = module.n\n}`,
      'output "size" { value = sensitive(1) }\noutput "name" { value = "n" }',
      'length(local.n[0].name)',
    ],
    ['a value a resource is given beside a sensitive one', `${FILE}\nlocals {\n  f = local_file.f\n}`, '', 'length(local.f.path)'],
  ])('takes a count from %s', async (_, before, inner, count) => {
    await module(counted(count, before), inner);

    const plan = await newOrchestrator().plan(CALL);

    expect(plan.actions).toEqual([]);
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

describe('a resource that reads another as written', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-no-instances-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  // Each is checked after the one it reads, so reading a value as written takes one step; the last of the chain comes first.
  it('is checked through a chain longer than the call stack holds', async () => {
    const links = Array.from({ length: 1500 }, (_, step) => `resource "local_file" "f${step + 1}" {\n  path    = "f${step + 1}"\n  content = local_file.f${step}.content\n}`);
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());

    const plan = await engine.plan([...links.reverse(), 'resource "local_file" "f0" {\n  path    = "f0"\n  content = "x"\n}'].join('\n'));

    const names = Array.from({ length: 1501 }, (_, step) => `f${step}`);
    expect(plan.actions.map((action) => [action.type, action.name]).sort()).toEqual(names.map((name) => ['CREATE', name]).sort());
  });
});
