import { ExactNumber, types, UNKNOWN } from '@clay/contracts';
import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { ConfigError } from '@clay/parser';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { start } from './start';

/** The line and column `needle` is first written at, as an error would point at it. */
const placeOf = (config: string, needle: string) => {
  const before = config.slice(0, config.indexOf(needle)).split('\n');
  return { line: before.length, column: before.at(-1)!.length + 1 };
};

const errorOf = async (run: () => Promise<unknown>): Promise<ConfigError> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof ConfigError) return error;

    throw error;
  }

  throw new Error('Expected the configuration to be refused');
};

describe('a variable that names its type', () => {
  let dir: string;

  const newOrchestrator = () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    return engine;
  };

  const writeModule = async (content: string) => {
    await fs.mkdir(path.join(dir, 'm'), { recursive: true });
    await fs.writeFile(path.join(dir, 'm', 'main.clay'), content, 'utf8');
  };

  const apply = async (config: string) => {
    for await (const event of start(newOrchestrator(), config)) if (event.type === 'failed') throw event.error;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-variable-type-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('takes a list given for a set as a set, so a resource reading it gets each member once and in order', async () => {
    const file = path.join(dir, 'names.txt');
    await writeModule(
      `variable "names" { type = set(string) }\nresource "local_file" "f" {\n  path    = ${JSON.stringify(file)}\n  content = "\${length(var.names)}"\n}\noutput "names" { value = var.names }`
    );
    const config = 'module "m" {\n  source = "./m"\n  names  = ["b", "a", "a"]\n}\noutput "names" { value = module.m.names }';

    await apply(config);

    expect(await fs.readFile(file, 'utf8')).toBe('2');
    const state = JSON.parse(await fs.readFile(path.join(dir, 'clay.state.json'), 'utf8'));
    expect(state.outputs.names).toEqual({ value: ['a', 'b'], type: types.set(types.string) });
  });

  it('makes one instance for each member of a set given as a list', async () => {
    await writeModule('variable "names" { type = set(string) }\nresource "null_resource" "n" { for_each = var.names }');
    const config = 'module "m" {\n  source = "./m"\n  names  = ["b", "a", "a"]\n}';

    const plan = await newOrchestrator().plan(config);

    expect(plan.actions.map((action) => action.key)).toEqual(['a', 'b']);
  });

  it('reads the type of a value not known yet into any', async () => {
    const config = 'resource "random_string" "r" { length = 4 }\nmodule "m" {\n  source = "./m"\n  x      = random_string.r.result\n}\noutput "x" { value = module.m.x }';
    await writeModule('variable "x" { type = any }\noutput "x" { value = var.x }');

    const plan = await newOrchestrator().plan(config);

    expect(plan.outputs.x.new).toEqual({ value: UNKNOWN, type: types.string });
  });

  it('takes a default as its type', async () => {
    const config = 'variable "port" {\n  type    = string\n  default = 8080\n}\noutput "port" { value = var.port }';

    const plan = await newOrchestrator().plan(config);

    expect(plan.outputs.port.new).toEqual({ value: '8080', type: types.string });
  });

  it('refuses an input of the wrong type where the module call gives it', async () => {
    await writeModule('variable "port" { type = number }');
    const config = 'module "m" {\n  source = "./m"\n  port   = "eighty"\n}';

    const error = await errorOf(() => newOrchestrator().plan(config));

    expect(error.message).toBe('port: "eighty" is not a number');
    expect(error.position).toEqual({ file: 'main.clay', ...placeOf(config, '"eighty"') });
    expect(error.block).toBe('module "m"');
  });

  it.each([
    ['count = 0', 'count  = 0', '"eighty"', 'port: "eighty" is not a number'],
    ['an empty for_each', 'for_each = {}', '"eighty"', 'port: "eighty" is not a number'],
    ['count = 0, given by a call', 'count  = 0', 'tolist(["a"])', 'port is a list, where variable "port" takes a number'],
    ['count = 0, given by a for', 'count  = 0', '[for p in ["a"] : p]', 'port is a tuple, where variable "port" takes a number'],
  ])('refuses a constant input of the wrong type to a module call with %s, which makes no instance to read it', async (_, repeat, given, message) => {
    await writeModule('variable "port" { type = number }');
    const config = `module "m" {\n  source = "./m"\n  ${repeat}\n  port   = ${given}\n}`;

    const error = await errorOf(() => newOrchestrator().plan(config));

    expect(error.message).toBe(message);
    expect(error.position).toEqual({ file: 'main.clay', ...placeOf(config, given) });
    expect(error.block).toBe('module "m"');
  });

  it('refuses a constant input of the wrong type to a call inside a module that makes no instance', async () => {
    const module = 'module "n" {\n  source = "./n"\n  port   = "eighty"\n}';
    await writeModule(module);
    await fs.mkdir(path.join(dir, 'm', 'n'));
    await fs.writeFile(path.join(dir, 'm', 'n', 'main.clay'), 'variable "port" { type = number }', 'utf8');
    const config = 'module "m" {\n  source = "./m"\n  count  = 0\n}';

    const error = await errorOf(() => newOrchestrator().plan(config));

    expect(error.message).toBe('port: "eighty" is not a number');
    expect(error.position).toEqual({ file: path.join('m', 'main.clay'), ...placeOf(module, '"eighty"') });
    expect(error.module).toBe('module.m');
  });

  it('reads a variable named as an object property only from what the call gives', async () => {
    await writeModule('variable "constructor" {\n  type    = number\n  default = 1\n}\noutput "n" { value = var.constructor }');
    const config = 'module "m" { source = "./m" }\noutput "n" { value = module.m.n }';

    const plan = await newOrchestrator().plan(config);

    expect(plan.outputs.n.new).toEqual({ value: ExactNumber.parse('1'), type: types.number });
  });

  it('refuses an attribute an object type does not name, where it is given', async () => {
    await writeModule('variable "site" { type = object({ name = string }) }');
    const config = 'module "m" {\n  source = "./m"\n  site   = { name = "a", nmae = "b" }\n}';

    const error = await errorOf(() => newOrchestrator().plan(config));

    expect(error.message).toBe('variable "site" has no attribute "nmae" in site');
    expect(error.position).toEqual({ file: 'main.clay', ...placeOf(config, '{ name') });
  });

  it('refuses a default of the wrong type even where the module call gives a value in its place', async () => {
    const module = 'variable "port" {\n  type    = number\n  default = "eighty"\n}';
    await writeModule(module);
    const config = 'module "m" {\n  source = "./m"\n  port   = 80\n}';

    const error = await errorOf(() => newOrchestrator().plan(config));

    expect(error.message).toBe('port: "eighty" is not a number');
    expect(error.position).toEqual({ file: path.join('m', 'main.clay'), ...placeOf(module, '"eighty"') });
    expect(error.block).toBe('variable "port"');
  });

  it('refuses an input of the wrong type at the input, when a data source reads it before the plan does', async () => {
    await fs.writeFile(path.join(dir, 'in.txt'), 'hi', 'utf8');
    await writeModule('variable "file" { type = object({ path = string }) }\ndata "local_file" "f" { path = var.file.path }');
    const config = 'variable "f" { default = "in.txt" }\nmodule "m" {\n  source = "./m"\n  file   = var.f\n}';

    const error = await errorOf(() => newOrchestrator().plan(config));

    expect(error.message).toBe('file is a string, where variable "file" takes an object');
    expect(error.position).toEqual({ file: 'main.clay', ...placeOf(config, 'var.f\n') });
    expect(error.block).toBe('module "m"');
  });

  it('gives a value not known yet the type it names, and holds it to that type once the apply knows it', async () => {
    await writeModule('variable "n" { type = number }\noutput "n" { value = var.n }');
    const config = 'resource "random_string" "r" { length = 4 }\nmodule "m" {\n  source = "./m"\n  n      = random_string.r.result\n}\noutput "n" { value = module.m.n }';

    const plan = await newOrchestrator().plan(config);
    expect(plan.outputs.n.new).toEqual({ value: UNKNOWN, type: types.number });

    const error = await errorOf(() => apply(config));
    expect(error.message).toContain('n: "');
    expect(error.message).toContain('is not a number');
    expect(error.position).toEqual({ file: 'main.clay', ...placeOf(config, 'random_string.r.result') });
  });

  it('refuses at plan a value not known yet whose type can never be the one named', async () => {
    await writeModule('variable "names" { type = list(string) }');
    const config = 'resource "random_string" "r" { length = 4 }\nmodule "m" {\n  source = "./m"\n  names  = random_string.r.result\n}';

    const error = await errorOf(() => newOrchestrator().plan(config));

    expect(error.message).toBe('names is a string known only after apply, where variable "names" takes a list');
    expect(error.position).toEqual({ file: 'main.clay', ...placeOf(config, 'random_string.r.result') });
  });

  it('joins the items of list(any) into one type', async () => {
    const config = 'variable "mixed" {\n  type    = list(any)\n  default = [1, "x"]\n}\noutput "mixed" { value = var.mixed }';

    const plan = await newOrchestrator().plan(config);

    expect(plan.outputs.mixed.new).toEqual({ value: ['1', 'x'], type: types.list(types.string) });
  });

  it('keeps a number exact through a string type and back', async () => {
    const config = 'variable "big" {\n  type    = number\n  default = "12345678901234567890.5"\n}\noutput "big" { value = var.big }';

    const plan = await newOrchestrator().plan(config);

    expect(plan.outputs.big.new).toEqual({ value: ExactNumber.parse('12345678901234567890.5'), type: types.number });
  });
});
