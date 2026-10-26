import { ExactNumber, types } from '@clay/contracts';

import { ConfigError } from '@clay/parser';

import { LocalBackend } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { orchestratorIn, placeOf } from '../helpers';
import { start } from '../start';

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

  const newOrchestrator = () => orchestratorIn(dir);

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

  it('reads another variable in a rule', async () => {
    const config =
      'variable "max" { default = 100 }\nvariable "port" {\n  default = 200\n  validation {\n    condition     = var.port <= var.max\n    error_message = "port is above ${var.max}"\n  }\n}';

    const error = await planError(config);

    expect(error.message).toBe('variable "port": port is above 100');
    expect(error.position).toMatchObject(placeOf(config, '200'));
  });

  it("reads a module input's rule in the module, not in the call", async () => {
    await module(
      'locals { limit = 10 }\nvariable "n" {\n  type = number\n  validation {\n    condition     = var.n <= local.limit\n    error_message = "n is above ${local.limit}"\n  }\n}'
    );
    const config = 'locals { limit = 1000 }\nmodule "m" {\n  source = "./m"\n  n      = 50\n}';

    const error = await planError(config);

    expect(error.message).toBe('variable "n": n is above 10');
    expect(error.position).toMatchObject(placeOf(config, '50'));
  });

  it("reads the module's own variable in a module input's rule, not the caller's", async () => {
    await module(
      'variable "max" { default = 10 }\nvariable "n" {\n  type = number\n  validation {\n    condition     = var.n <= var.max\n    error_message = "n is above ${var.max}"\n  }\n}'
    );
    const config = 'variable "max" { default = 1000 }\nmodule "m" {\n  source = "./m"\n  n      = var.max\n}';

    const error = await planError(config);

    expect(error.message).toBe('variable "n": n is above 10');
  });

  it('reads a data source in a rule after the data source is read', async () => {
    const reserved = path.join(dir, 'reserved.txt');
    await fs.writeFile(reserved, 'admin');
    // Declared after the variable, so only the dependency reads it first.
    const config = `variable "name" {\n  default = "admin"\n  validation {\n    condition     = var.name != data.local_file.reserved.content\n    error_message = "\${var.name} is reserved"\n  }\n}\ndata "local_file" "reserved" { path = "${reserved}" }`;

    const error = await planError(config);

    expect(error.message).toBe('variable "name": admin is reserved');
  });

  it('checks at the apply, after the resource is created, a rule that reads it', async () => {
    const config =
      'resource "random_string" "s" { length = 4 }\nvariable "id" {\n  default = "abc"\n  validation {\n    condition     = length(var.id) == length(random_string.s.result)\n    error_message = "id has ${length(var.id)} characters, not ${length(random_string.s.result)}"\n  }\n}';

    const plan = await newOrchestrator().plan(config);
    const error = await failure(() => apply(config));

    expect(plan.actions.map((action) => `${action.type} ${action.name}`)).toEqual(['CREATE s']);
    expect(error.message).toBe('variable "id": id has 3 characters, not 4');
    expect(error.position).toMatchObject(placeOf(config, '"abc"'));
  });

  it('records what a rule reads as a dependency of a resource that reads the variable', async () => {
    const file = path.join(dir, 'id.txt');
    const config = `resource "random_string" "s" { length = 4 }\nvariable "id" {\n  default = "abc"\n  validation {\n    condition     = length(random_string.s.result) > length(var.id)\n    error_message = "x"\n  }\n}\nresource "local_file" "f" {\n  path    = "${file}"\n  content = var.id\n}`;

    await apply(config);

    const state = await new LocalBackend(dir).read();
    expect(state.resources['local_file.f'].dependencies).toEqual(['random_string.s']);
  });

  it.each([
    ['in the root module', ''],
    ['in a module called with count = 0', 'module "m" {\n  source = "./m"\n  count  = 0\n}'],
  ])('refuses at plan a rule that reads an attribute the resource does not have, %s', async (_, call) => {
    const rule =
      'resource "random_string" "s" { length = 4 }\nvariable "n" {\n  default = "a"\n  validation {\n    condition     = var.n != random_string.s.no_such\n    error_message = "x"\n  }\n}';
    if (call) await module(rule);

    const error = await planError(call || rule);

    expect(error.message).toBe('random_string has no attribute "no_such"');
    expect(error.position).toMatchObject(placeOf(rule, 'random_string.s.no_such'));
  });

  it('refuses a rule that reads what reads its variable, as a cycle', async () => {
    const config =
      'locals { doubled = var.n * 2 }\nvariable "n" {\n  default = 1\n  validation {\n    condition     = local.doubled > var.n\n    error_message = "n is negative"\n  }\n}';

    const error = await planError(config);

    expect(error.message).toBe('Dependency cycle detected: local.doubled -> var.n -> local.doubled');
    expect(error.position).toMatchObject(placeOf(config, 'var.n * 2'));
  });

  it.each([
    ['a local the module does not declare', 'var.n > local.min', 'local.min', 'local "min" is not defined'],
    ['count.index, though the call has count', 'var.n > count.index', 'count.index', 'count.index is only known inside a resource, a data source or a module call that has count'],
  ])('refuses a rule that reads %s, where the module writes it', async (_, condition, needle, expected) => {
    const rule = `variable "n" {\n  type = number\n  validation {\n    condition     = ${condition}\n    error_message = "x"\n  }\n}`;
    await module(rule);

    const error = await planError('module "m" {\n  source = "./m"\n  count  = 2\n  n      = 1\n}');

    expect(error.message).toBe(expected);
    expect(error.position).toMatchObject(placeOf(rule, needle));
    expect(error.block).toBe('variable "n"');
    expect(error.module).toBe('module.m');
  });
});
