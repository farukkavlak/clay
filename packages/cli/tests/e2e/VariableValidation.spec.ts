import { ExactNumber, types } from '@clay/contracts';
import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { ConfigError } from '@clay/parser';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { start } from './start';

/** Where an error would point at the first `needle`. */
const placeOf = (config: string, needle: string) => {
  const before = config.slice(0, config.indexOf(needle)).split('\n');
  return { line: before.length, column: before.at(-1)!.length + 1 };
};

const rules = (name: string) => `
  validation {
    condition     = var.${name} > 0
    error_message = "${name} must be positive"
  }
  validation {
    condition     = var.${name} < 65536
    error_message = "${name} must be below 65536, not \${var.${name}}"
  }`;

const port = (value: string) => `variable "port" {\n  type    = number\n  default = ${value}\n${rules('port')}\n}\noutput "port" { value = var.port }`;

const checked = `variable "port" {\n  type = number\n${rules('port')}\n}\noutput "port" { value = var.port }`;

async function failure(run: () => Promise<unknown>): Promise<ConfigError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ConfigError) return error;

    throw error;
  }

  throw new Error('Expected the run to fail');
}

describe('a variable with validation', () => {
  let dir: string;

  const newOrchestrator = () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    return engine;
  };

  const apply = async (config: string) => {
    for await (const event of start(newOrchestrator(), config)) if (event.type === 'failed') throw event.error;
  };

  const planError = (config: string) => failure(() => newOrchestrator().plan(config));

  const module = (content: string) => fs.writeFile(path.join(dir, 'm', 'main.clay'), content);

  const outputs = async () => {
    const state = await new LocalBackend(dir).read();
    return state.outputs;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-validation-'));
    await fs.mkdir(path.join(dir, 'm'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('takes a value every rule accepts', async () => {
    await apply(port('8080'));

    expect(await outputs()).toEqual({ port: { value: ExactNumber.parse('8080'), type: types.number } });
  });

  it('refuses a default a rule does not accept, with its message, where the default is written', async () => {
    const config = port('70000');

    const error = await planError(config);

    expect(error.message).toBe('variable "port": port must be below 65536, not 70000');
    expect(error.position).toMatchObject(placeOf(config, '70000'));
    expect(error.block).toBe('variable "port"');
  });

  it('checks a variable nothing reads', async () => {
    const config = 'variable "port" {\n  default = 0\n  validation {\n    condition     = var.port > 0\n    error_message = "port must be positive"\n  }\n}';

    const error = await planError(config);

    expect(error.message).toBe('variable "port": port must be positive');
  });

  it('refuses a module input a rule does not accept, where the call gives it', async () => {
    await module(checked);
    const config = 'module "m" {\n  source = "./m"\n  port   = -1\n}';

    const error = await planError(config);

    expect(error.message).toBe('variable "port": port must be positive');
    expect(error.position).toMatchObject(placeOf(config, '-1'));
    expect(error.block).toBe('module "m"');
    expect(error.module).toBeUndefined();
  });

  it('checks the input of each instance of a module, where the call gives it', async () => {
    await module(checked);
    const config = 'module "m" {\n  source   = "./m"\n  for_each = { a = 80, b = 0 }\n  port     = each.value\n}';

    const error = await planError(config);

    expect(error.message).toBe('variable "port": port must be positive');
    expect(error.position).toMatchObject(placeOf(config, 'each.value'));
    expect(error.block).toBe('module "m"');
  });

  // A known false on the left reads the right by type alone, in each instance of the module.
  it('reads a rule joined with && in each instance of a module called with count', async () => {
    await module(
      'variable "name" {\n  type = string\n  validation {\n    condition     = length(var.name) > 2 && var.name != "admin"\n    error_message = "name is too short or taken"\n  }\n}'
    );
    const config = 'module "m" {\n  source = "./m"\n  count  = 2\n  name   = count.index == 0 ? "web" : "x"\n}';

    const error = await planError(config);

    expect(error.message).toBe('variable "name": name is too short or taken');
    expect(error.position).toMatchObject(placeOf(config, 'count.index == 0'));
  });

  it('gives a message written as a heredoc without the line break that ends it', async () => {
    const config = 'variable "port" {\n  default = 0\n  validation {\n    condition     = var.port > 0\n    error_message = <<EOT\nport must be positive\nEOT\n  }\n}';

    const error = await planError(config);

    expect(error.message).toBe('variable "port": port must be positive');
  });

  it('waits for the apply where the value is not known until then, and checks it there', async () => {
    await module(
      'variable "id" {\n  type = string\n  validation {\n    condition     = length(var.id) == 3\n    error_message = "id has ${length(var.id)} characters"\n  }\n}\noutput "id" { value = var.id }'
    );
    const config = 'resource "random_string" "s" { length = 4 }\nmodule "m" {\n  source = "./m"\n  id     = random_string.s.result\n}\noutput "id" { value = module.m.id }';

    await newOrchestrator().plan(config);
    const error = await failure(() => apply(config));

    expect(error.message).toBe('variable "id": id has 4 characters');
    expect(error.position).toMatchObject(placeOf(config, 'random_string.s.result\n'));
  });

  it('hides a message that holds a sensitive value, and still refuses it', async () => {
    const config =
      'variable "token" {\n  default   = "short"\n  sensitive = true\n  validation {\n    condition     = length(var.token) > 8\n    error_message = "token ${var.token} is too short"\n  }\n}';

    const error = await planError(config);

    expect(error.message).toBe('variable "token": the error_message holds a sensitive value, so it is not shown');
  });

  it.each([
    ['a condition that gives no boolean', 'var.port + 1', '"x"', 'var.port + 1', "A validation's condition takes a boolean, not a number"],
    ['a condition that gives null', 'var.port > 0 ? null : null', '"x"', 'var.port > 0 ? null', "A validation's condition takes a boolean, not null"],
    ['a message that gives no string', 'var.port < 0', '5', '5\n', "A validation's error_message is a string, not a number"],
  ])('refuses %s, where the module writes it', async (_, condition, message, needle, expected) => {
    const rule = `variable "port" {\n  type = number\n  validation {\n    condition     = ${condition}\n    error_message = ${message}\n  }\n}`;
    await module(rule);

    const error = await planError('module "m" {\n  source = "./m"\n  port   = 1\n}');

    expect(error.message).toBe(expected);
    expect(error.position).toMatchObject(placeOf(rule, needle));
    expect(error.block).toBe('variable "port"');
    expect(error.module).toBe('module.m');
  });

  it('checks at the apply a variable nothing reads, where its value is not known until then', async () => {
    await module('variable "id" {\n  type = string\n  validation {\n    condition     = length(var.id) == 3\n    error_message = "id has ${length(var.id)} characters"\n  }\n}');
    const config = 'resource "random_string" "s" { length = 4 }\nmodule "m" {\n  source = "./m"\n  id     = random_string.s.result\n}';

    const error = await failure(() => apply(config));

    expect(error.message).toBe('variable "id": id has 4 characters');
    expect(error.position).toMatchObject(placeOf(config, 'random_string.s.result\n'));
  });

  it('waits for the apply where the condition reads a part of the value not known until then', async () => {
    await module('variable "o" {\n  type = object({ n = number, id = string })\n  validation {\n    condition     = var.o.id != ""\n    error_message = "no id"\n  }\n}');

    const plan = await newOrchestrator().plan('resource "random_string" "s" { length = 4 }\nmodule "m" {\n  source = "./m"\n  o      = { n = 1, id = random_string.s.result }\n}');

    expect(plan.actions.map((action) => `${action.type} ${action.name}`)).toEqual(['CREATE s']);
  });

  it('waits for the apply where reading the condition needs a value not known until then', async () => {
    await module('variable "id" {\n  type = string\n  validation {\n    condition     = lookup({ abc = true }, var.id, false)\n    error_message = "unknown id"\n  }\n}');

    const plan = await newOrchestrator().plan('resource "random_string" "s" { length = 3 }\nmodule "m" {\n  source = "./m"\n  id     = random_string.s.result\n}');

    expect(plan.actions.map((action) => `${action.type} ${action.name}`)).toEqual(['CREATE s']);
  });

  it('refuses a message not known until the apply, where the rule already refuses the value', async () => {
    const rule =
      'variable "o" {\n  type = object({ n = number, id = string })\n  validation {\n    condition     = var.o.n > 5\n    error_message = "too small for ${var.o.id}"\n  }\n}';
    await module(rule);

    const error = await planError('resource "random_string" "s" { length = 4 }\nmodule "m" {\n  source = "./m"\n  o      = { n = 1, id = random_string.s.result }\n}');

    expect(error.message).toBe("A validation's error_message is not known until the apply");
    expect(error.position).toMatchObject(placeOf(rule, '"too small'));
  });
});
