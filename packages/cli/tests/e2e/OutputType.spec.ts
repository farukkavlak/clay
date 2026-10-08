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

/** Where an error would point at the first `needle`. */
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

describe('an output that names its type', () => {
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
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-output-type-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('converts its value to the type, in the plan and in state', async () => {
    const config = 'output "port" {\n  type  = string\n  value = 8080\n}';

    const plan = await newOrchestrator().plan(config);
    await apply(config);

    expect(plan.outputs.port.new).toEqual({ value: '8080', type: types.string });
    const state = JSON.parse(await fs.readFile(path.join(dir, 'clay.state.json'), 'utf8'));
    expect(state.outputs.port).toEqual({ value: '8080', type: types.string });
  });

  it('fills an optional attribute its type leaves out with the default', async () => {
    const config = 'output "site" {\n  type  = object({ name = string, port = optional(number, 80) })\n  value = { name = "a" }\n}';

    const plan = await newOrchestrator().plan(config);

    expect(plan.outputs.site.new).toEqual({ value: { name: 'a', port: ExactNumber.parse('80') }, type: types.object({ name: types.string, port: types.number }) });
  });

  it('joins every instance of a module into the type its outputs hold once filled, with no attribute left optional', async () => {
    await writeModule('output "site" {\n  type  = object({ name = string, port = optional(number, 80) })\n  value = { name = "a" }\n}');
    const config = 'module "web" {\n  source = "./m"\n  count  = 2\n}\noutput "all" { value = module.web }';

    const plan = await newOrchestrator().plan(config);

    const site = types.object({ name: types.string, port: types.number });
    expect(plan.outputs.all.new?.type).toEqual(types.list(types.object({ site })));
  });

  it('refuses a value of the wrong type where it is written', async () => {
    const config = 'output "port" {\n  type  = number\n  value = "eighty"\n}';

    const error = await errorOf(() => newOrchestrator().plan(config));

    expect(error.message).toBe('port: "eighty" is not a number');
    expect(error.position).toEqual({ file: 'main.clay', ...placeOf(config, '"eighty"') });
    expect(error.block).toBe('output "port"');
  });

  it('names the output, not a variable, where the kinds differ', async () => {
    const config = 'output "port" {\n  type  = number\n  value = ["a"]\n}';

    const error = await errorOf(() => newOrchestrator().plan(config));

    expect(error.message).toBe('port is a tuple, where output "port" takes a number');
  });

  it('refuses a value of the wrong type in a module called with count = 0, which makes no instance', async () => {
    const module = 'output "port" {\n  type  = number\n  value = "eighty"\n}';
    await writeModule(module);
    const config = 'module "m" {\n  source = "./m"\n  count  = 0\n}';

    const error = await errorOf(() => newOrchestrator().validate(config));

    expect(error.message).toBe('port: "eighty" is not a number');
    expect(error.position).toEqual({ file: path.join('m', 'main.clay'), ...placeOf(module, '"eighty"') });
  });

  it('refuses a default of the wrong type even where the value sets the attribute', async () => {
    const config = 'output "site" {\n  type  = object({ port = optional(number, "eighty") })\n  value = { port = 80 }\n}';

    const error = await errorOf(() => newOrchestrator().plan(config));

    expect(error.message).toBe('port: "eighty" is not a number');
    expect(error.position).toEqual({ file: 'main.clay', ...placeOf(config, '"eighty"') });
  });

  it('refuses a default of the wrong type where it is written, when the value leaves it to the default', async () => {
    const config = 'output "site" {\n  type  = object({ port = optional(number, "eighty") })\n  value = {}\n}';

    const error = await errorOf(() => newOrchestrator().validate(config));

    expect(error.message).toBe('port: "eighty" is not a number');
    expect(error.position).toEqual({ file: 'main.clay', ...placeOf(config, '"eighty"') });
    expect(error.block).toBe('output "site"');
  });

  it('gives a value not known yet the type it names, and holds it to that type once the apply knows it', async () => {
    const config = 'resource "random_string" "r" { length = 4 }\noutput "n" {\n  type  = number\n  value = random_string.r.result\n}';

    const plan = await newOrchestrator().plan(config);
    expect(plan.outputs.n.new).toEqual({ value: UNKNOWN, type: types.number });

    const error = await errorOf(() => apply(config));
    expect(error.message).toMatch(/^n: ".{4}" is not a number$/);
    expect(error.position).toEqual({ file: 'main.clay', ...placeOf(config, 'random_string.r.result') });
  });

  it("holds a module output not known yet to its type once the apply knows it, in the module's file", async () => {
    const module = 'resource "random_string" "r" { length = 4 }\noutput "n" {\n  type  = number\n  value = random_string.r.result\n}';
    await writeModule(module);
    const config = 'module "m" { source = "./m" }\noutput "n" { value = module.m.n }';

    const error = await errorOf(() => apply(config));

    expect(error.message).toMatch(/^n: ".{4}" is not a number$/);
    expect(error.position).toEqual({ file: path.join('m', 'main.clay'), ...placeOf(module, 'random_string.r.result') });
  });

  it("lets validate hold a module output's type to where it is given, where no plan reads it", async () => {
    await writeModule('output "names" {\n  type  = list(string)\n  value = ["a"]\n}');
    const config = 'module "web" { source = "./m" }\nresource "random_string" "r" {\n  count  = 0\n  length = module.web.names\n}';

    const error = await errorOf(() => newOrchestrator().validate(config));

    expect(error.message).toBe('length is a list, where random_string takes a number');
    expect(error.position).toEqual({ file: 'main.clay', ...placeOf(config, 'module.web.names') });
  });
});
