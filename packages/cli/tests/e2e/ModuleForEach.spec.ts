import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { Address } from '@clay/contracts';
import { ConfigError } from '@clay/parser';
import { parsePlanFile, serializePlan } from '@clay/planner';
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

/** The call of `web` over `forEach`, each instance named by its key and given its value. */
const web = (forEach: string, rest = '') => `
  module "web" {
    source = "./web"
    for_each = ${forEach}
    name = "\${each.key}"
    body = "\${each.value}"
  }
  ${rest}
`;

describe('a module called with for_each', () => {
  let dir: string;

  const newOrchestrator = () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    return engine;
  };

  const apply = async (config: string): Promise<Record<string, unknown>> => {
    let outputs: Record<string, unknown> = {};
    for await (const event of start(newOrchestrator(), config)) {
      if (event.type === 'failed') throw event.error;
      if (event.type === 'done') outputs = event.outputs;
    }
    return outputs;
  };

  const planError = async (config: string): Promise<ConfigError> => {
    try {
      await newOrchestrator().plan(config);
    } catch (error) {
      if (error instanceof ConfigError) return error;

      throw error;
    }

    throw new Error('Expected the plan to fail');
  };

  const writeModule = async (name: string, body: string) => {
    await fs.mkdir(path.join(dir, name), { recursive: true });
    await fs.writeFile(path.join(dir, name, 'main.clay'), body, 'utf8');
  };

  /** A module that writes one page, named by what it is given and holding what else it is given. */
  const page = () => `
    variable "name" {}
    variable "body" { default = "" }
    resource "local_file" "page" {
      path = "${path.join(dir, '${var.name}.txt')}"
      content = "\${var.body}"
    }
    output "path" { value = "\${local_file.page.path}" }
  `;

  const pages = async () => {
    const names = await fs.readdir(dir);
    return names.filter((name) => name.endsWith('.txt')).sort();
  };

  const stateKeys = async () => {
    const state = await new LocalBackend(dir).read();
    return Object.keys(state.resources).sort();
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-module-for-each-'));
    await writeModule('web', page());
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('makes one instance of the module for each key of a map, each given its key and value', async () => {
    await apply(web('{ ali = "80", ayse = "8080" }'));

    expect(await pages()).toEqual(['ali.txt', 'ayse.txt']);
    expect(await fs.readFile(path.join(dir, 'ayse.txt'), 'utf8')).toBe('8080');
    expect(await stateKeys()).toEqual(['module.web["ali"].local_file.page', 'module.web["ayse"].local_file.page']);
  });

  it('makes one for each string of a list, each its own value', async () => {
    await apply(web('["ali", "can"]'));

    expect(await fs.readFile(path.join(dir, 'can.txt'), 'utf8')).toBe('can');
  });

  // The for_each is read once the output it reads has its value, so the call waits on the other module.
  it('reads for_each from the output of another module', async () => {
    await writeModule('names', 'output "list" { value = ["ali", "can"] }');

    await apply(`module "names" { source = "./names" }\n${web('module.names.list')}`);

    expect(await pages()).toEqual(['ali.txt', 'can.txt']);
  });

  it('destroys the instance of a key taken out, and every one when for_each is empty', async () => {
    await apply(web('["ali", "can"]'));

    await apply(web('["can"]'));
    expect(await pages()).toEqual(['can.txt']);

    await apply(web('[]'));
    expect(await stateKeys()).toEqual([]);
  });

  it.each([
    ['in brackets', 'module.web["ali"].path'],
    ['after a dot', 'module.web.ali.path'],
  ])('gives the output of the instance a key names %s', async (_, reference) => {
    const outputs = await apply(web('["ali", "can"]', `output "o" { value = "\${${reference}}" }`));

    expect(outputs.o).toBe(path.join(dir, 'ali.txt'));
  });

  // Each instance of the outer module reads the inner call's for_each with its own input.
  it('reads the for_each of a call in a module in each instance of that module', async () => {
    await writeModule(
      'outer',
      `
      variable "prefix" {}
      variable "bodies" {}
      module "inner" {
        source = "../web"
        for_each = var.bodies
        name = "\${var.prefix}-\${each.key}"
        body = "\${each.value}"
      }
    `
    );

    await apply('module "outer" {\n source = "./outer"\n count = 2\n prefix = "o${count.index}"\n bodies = { a = "v${count.index}", b = "w${count.index}" }\n}');

    expect(await pages()).toEqual(['o0-a.txt', 'o0-b.txt', 'o1-a.txt', 'o1-b.txt']);
    expect(await fs.readFile(path.join(dir, 'o0-a.txt'), 'utf8')).toBe('v0');
    expect(await fs.readFile(path.join(dir, 'o1-a.txt'), 'utf8')).toBe('v1');
    expect(await stateKeys()).toContain('module.outer[1].module.inner["b"].local_file.page');
  });

  // No key stands for the module the way [0] does for a count, so what was there is destroyed and made again.
  it.each([
    ['added', 'module "web" {\n source = "./web"\n name = "ali"\n}', web('["ali"]'), 'module.web["ali"].local_file.page', 'module.web.local_file.page'],
    ['taken off', web('["ali"]'), 'module "web" {\n source = "./web"\n name = "ali"\n}', 'module.web.local_file.page', 'module.web["ali"].local_file.page'],
  ])('moves nothing when for_each is %s', async (_, before, after, made, destroyed) => {
    await apply(before);

    const { actions } = await newOrchestrator().plan(after);

    expect(actions.map((action) => [action.type, Address.of(action).toString(), action.movedFrom])).toEqual([
      ['CREATE', made, undefined],
      ['DELETE', destroyed, undefined],
    ]);
  });

  // A saved plan is read back from its file and run against the configuration it carries, which gives each instance its value again.
  it('runs a saved plan, each instance given its value', async () => {
    const saved = parsePlanFile(serializePlan(await newOrchestrator().plan(web('{ ali = "80" }')), web('{ ali = "80" }'), {}), 'plan.json');

    for await (const event of newOrchestrator().runPlan(saved, web('{ ali = "80" }'))) if (event.type === 'failed') throw event.error;

    expect(await fs.readFile(path.join(dir, 'ali.txt'), 'utf8')).toBe('80');
  });

  it('plans nothing to do once applied', async () => {
    await apply(web('["ali", "can"]'));

    const { actions } = await newOrchestrator().plan(web('["ali", "can"]'));

    expect(actions.map((action) => action.type)).toEqual(['NO_OP', 'NO_OP']);
  });

  it.each([
    ['no key', 'module.web.path', 'Reference "module.web.path" names an instance and no output: module.web has for_each, so its key comes first, as in module.web["key"].out'],
    ['an index', 'module.web[0].path', 'module.web has for_each, so name one of it by key, as in module.web["key"]'],
    ['a key for_each does not give', 'module.web["zed"].path', 'module.web has no instance ["zed"], only ["ali"], ["can"]'],
  ])('refuses a reference to its output with %s, where it is written', async (_, reference, message) => {
    const config = web('["ali", "can"]', `output "o" { value = "\${${reference}}" }`);

    const error = await planError(config);

    expect(error.message).toBe(message);
    expect(error.position).toMatchObject(placeOf(config, reference));
  });

  it.each([
    ['each.key in the for_each it would come from', 'module "w" {\n source = "./web"\n for_each = each.key\n name = "x"\n}', 'each.key'],
    ['each.value in an input of a module called without for_each', 'module "w" {\n source = "./web"\n name = "${each.value}"\n}', 'each.value'],
  ])('refuses %s, where it is written', async (_, config, reference) => {
    const error = await planError(config);

    expect(error.message).toBe(`${reference} is only known inside a resource or a module call that has for_each`);
    expect(error.position).toMatchObject(placeOf(config, reference));
  });

  // The module is written once for every way it may be called, so it takes its key as an input.
  it('refuses each.key inside the module, where it is written in the module', async () => {
    const body = 'variable "name" {}\nvariable "body" {}\noutput "o" { value = "${each.key}" }';
    await writeModule('web', body);

    const error = await planError(web('["ali"]'));

    expect(error.message).toBe('each.key is only known inside a resource or a module call that has for_each');
    expect(error.position).toMatchObject({ file: 'web/main.clay', ...placeOf(body, 'each.key') });
  });

  it.each([
    ['a string twice', '["ali", "ali"]', 'for_each holds "ali" twice; each instance needs a key of its own'],
    ['a value only an apply makes', 'random_string.s.result', 'for_each must be known when planning: it reads a value only an apply makes'],
  ])('refuses a for_each with %s, where it is written', async (_, forEach, message) => {
    const config = `resource "random_string" "s" { length = 2 }\n${web(forEach)}`;

    const error = await planError(config);

    expect(error.message).toBe(message);
    expect(error.position).toMatchObject(placeOf(config, forEach));
  });

  it('refuses a data source in the module, where it is written', async () => {
    await writeModule('web', `data "local_file" "d" { path = "${path.join(dir, 'x')}" }\nvariable "name" {}\nvariable "body" {}`);

    const error = await planError(web('["ali"]'));

    expect(error.message).toBe('data "local_file" "d" is in a module called with count or for_each, where a data source cannot be read yet');
    expect(error.position).toMatchObject({ file: 'web/main.clay', line: 1, column: 1 });
  });
});
