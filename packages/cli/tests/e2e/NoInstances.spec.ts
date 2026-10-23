import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { ConfigError } from '@clay/parser';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

  const module = async (content: string) => {
    await fs.mkdir(path.join(dir, 'm', 'n'), { recursive: true });
    await fs.writeFile(path.join(dir, 'm', 'n', 'main.clay'), '');
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

  it.each([
    [
      'a count sensitive only on a branch an instance may not take',
      'variable "b" {\n  type    = bool\n  default = false\n}\nresource "random_string" "s" {\n  count  = var.b ? sensitive(1) : 2\n  length = 4\n}',
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
