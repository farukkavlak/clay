import { Address, Output } from '@clay/contracts';
import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { ConfigError } from '@clay/parser';
import { parsePlanFile, serializePlan } from '@clay/planner';
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

const web = (count: string, rest = '') => `
  module "web" {
    source = "./web"
    count = ${count}
    name = "site-\${count.index}"
  }
  ${rest}
`;

const once = (count?: string, name = 'site') => `module "web" {\n source = "./web"\n${count ? ` count = ${count}\n` : ''} name = "${name}"\n}`;

describe('a module called with count', () => {
  let dir: string;

  const newOrchestrator = () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    return engine;
  };

  const apply = async (config: string): Promise<Record<string, Output>> => {
    let outputs: Record<string, Output> = {};
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

  const page = () => `
    variable "name" {}
    resource "local_file" "page" {
      path = "${path.join(dir, '${var.name}.txt')}"
      content = "page \${var.name}"
    }
    output "path" { value = "\${local_file.page.path}" }
  `;

  /** Adds count to the resource too, still writing one file. */
  const countedPage = () =>
    page().replace('resource "local_file" "page" {', 'resource "local_file" "page" {\n count = 1').replace('local_file.page.path', 'local_file.page[0].path');

  const pages = async () => {
    const names = await fs.readdir(dir);
    return names.filter((name) => name.endsWith('.txt')).sort();
  };

  const stateKeys = async () => {
    const state = await new LocalBackend(dir).read();
    return Object.keys(state.resources).sort();
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-module-count-'));
    await writeModule('web', page());
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('makes one instance of the module for each index, each given its own count.index', async () => {
    await apply(web('3'));

    expect(await pages()).toEqual(['site-0.txt', 'site-1.txt', 'site-2.txt']);
    expect(await fs.readFile(path.join(dir, 'site-2.txt'), 'utf8')).toBe('page site-2');
    expect(await stateKeys()).toEqual(['module.web[0].local_file.page', 'module.web[1].local_file.page', 'module.web[2].local_file.page']);
  });

  it('reads count from a variable', async () => {
    await apply(`variable "n" { default = 2 }\n${web('var.n')}`);

    expect(await pages()).toEqual(['site-0.txt', 'site-1.txt']);
  });

  // The call waits for the other module's output before reading count.
  it('reads count from the output of another module', async () => {
    await writeModule('sizes', 'output "n" { value = 2 }');

    await apply(`module "sizes" { source = "./sizes" }\n${web('module.sizes.n')}`);

    expect(await pages()).toEqual(['site-0.txt', 'site-1.txt']);
  });

  it('deletes the instances past a lower count, and every one at a count of 0', async () => {
    await apply(web('3'));

    await apply(web('1'));
    expect(await pages()).toEqual(['site-0.txt']);

    await apply(web('0'));
    expect(await pages()).toEqual([]);
    expect(await stateKeys()).toEqual([]);
  });

  it('gives the output of one instance to what reads it by index', async () => {
    const outputs = await apply(web('2', 'output "second" { value = "${module.web[1].path}" }'));

    expect(outputs.second.value).toBe(path.join(dir, 'site-1.txt'));
  });

  it('makes the instances of a module with count in each instance of a module with count', async () => {
    await writeModule(
      'outer',
      `
      variable "name" {}
      module "inner" {
        source = "../web"
        count = 2
        name = "\${var.name}-\${count.index}"
      }
      output "second" { value = "\${module.inner[1].path}" }
    `
    );

    const outputs = await apply('module "outer" {\n source = "./outer"\n count = 2\n name = "o${count.index}"\n}\noutput "o" { value = "${module.outer[1].second}" }');

    expect(await pages()).toEqual(['o0-0.txt', 'o0-1.txt', 'o1-0.txt', 'o1-1.txt']);
    expect(await stateKeys()).toContain('module.outer[1].module.inner[0].local_file.page');
    expect(outputs.o.value).toBe(path.join(dir, 'o1-1.txt'));
  });

  it('reads the count of a call in a module in each instance of that module', async () => {
    await writeModule(
      'grow',
      `
      variable "n" {}
      module "inner" {
        source = "../web"
        count = var.n
        name = "i\${var.n}-\${count.index}"
      }
    `
    );

    await apply('module "grow" {\n source = "./grow"\n count = 3\n n = count.index\n}');

    expect(await pages()).toEqual(['i1-0.txt', 'i2-0.txt', 'i2-1.txt']);
  });

  it('plans nothing to do once applied', async () => {
    await apply(web('2', 'output "second" { value = "${module.web[1].path}" }'));

    const { actions } = await newOrchestrator().plan(web('2', 'output "second" { value = "${module.web[1].path}" }'));

    expect(actions.map((action) => action.type)).toEqual(['NO_OP', 'NO_OP']);
  });

  // The plan never resolves the output, since it waits on the apply; the graph refuses it anyway.
  it('refuses a reference to its output with no index even where the plan does not read it', async () => {
    const config = web('2', 'resource "random_string" "s" { length = 4 }\noutput "o" { value = "${random_string.s.id}-${module.web.path}" }');

    const error = await planError(config);

    expect(error.message).toBe('module.web has count, so name one of it by index, as in module.web[0]');
    expect(error.position).toMatchObject(placeOf(config, 'module.web.path'));
  });

  it.each([
    ['no index', 'module.web.path', 'module.web has count, so name one of it by index, as in module.web[0]'],
    ['an index past the count', 'module.web[2].path', 'module.web has 2 instances, [0] to [1]'],
  ])('refuses a reference to its output with %s, where it is written', async (_, reference, message) => {
    const config = web('2', `output "o" { value = "\${${reference}}" }`);

    const error = await planError(config);

    expect(error.message).toBe(message);
    expect(error.position).toMatchObject(placeOf(config, reference));
  });

  it('says a module that is not declared is not, whatever index it is read at', async () => {
    const config = web('2', 'output "o" { value = "${module.wbe[0].path}" }');

    const error = await planError(config);

    expect(error.message).toBe('module "wbe" is not declared');
    expect(error.position).toMatchObject(placeOf(config, 'module.wbe[0]'));
  });

  // One engine plans many configurations, so one's calls must not carry into the next.
  it('forgets which calls had count when it plans another configuration', async () => {
    const engine = newOrchestrator();
    await engine.plan(web('2'));

    const { actions } = await engine.plan('module "web" {\n source = "./web"\n name = "one"\n}\noutput "o" { value = "${module.web.path}" }');

    expect(actions.map((action) => Address.of(action).toString())).toEqual(['module.web.local_file.page']);
  });

  it('refuses an index into a module called without count', async () => {
    const config = 'module "one" {\n source = "./web"\n name = "x"\n}\noutput "o" { value = "${module.one[0].path}" }';

    const error = await planError(config);

    expect(error.message).toBe('module.one has no count, so it takes no index');
    expect(error.position).toMatchObject(placeOf(config, 'module.one[0]'));
  });

  it.each([
    ['in the count it would come from', 'module "w" {\n source = "./web"\n count = count.index\n name = "x"\n}'],
    ['in an input of a module called without count', 'module "w" {\n source = "./web"\n name = "${count.index}"\n}'],
  ])('refuses count.index %s, where it is written', async (_, config) => {
    const error = await planError(config);

    expect(error.message).toBe('count.index is only known inside a resource, a data source or a module call that has count');
    expect(error.position).toMatchObject(placeOf(config, 'count.index'));
  });

  // A module may be called in any way, so it must take its index as an input.
  it('refuses count.index inside the module, where it is written in the module', async () => {
    const body = 'variable "name" {}\noutput "o" { value = "${count.index}" }';
    await writeModule('web', body);

    const error = await planError(web('2'));

    expect(error.message).toBe('count.index is only known inside a resource, a data source or a module call that has count');
    expect(error.position).toMatchObject({ file: 'web/main.clay', ...placeOf(body, 'count.index') });
  });

  it.each([
    ['a word', '"two"', 'count is a whole number from 0, not a string'],
    ['a negative number', '-1', 'count is a whole number from 0, not -1'],
    ['a number only an apply makes', 'length(random_string.s.id)', 'count must be known when planning: it reads a value only an apply makes'],
    ['a string only an apply makes', 'random_string.s.id', 'count is a whole number from 0, not a string'],
  ])('refuses a count that is %s, where it is written', async (_, count, message) => {
    const config = `resource "random_string" "s" { length = 2 }\n${web(count)}`;

    const error = await planError(config);

    expect(error.message).toBe(message);
    expect(error.position).toMatchObject(placeOf(config, count));
  });

  describe('added to a module that exists, or taken off', () => {
    it('moves what is in the module to its first instance, so nothing is made again', async () => {
      await apply(once());

      const { actions } = await newOrchestrator().plan(once('1'));
      expect(actions.map((action) => [action.type, Address.of(action).toString(), action.movedFrom])).toEqual([
        ['NO_OP', 'module.web[0].local_file.page', 'module.web.local_file.page'],
      ]);

      await apply(once('1'));
      expect(await pages()).toEqual(['site.txt']);
      expect(await stateKeys()).toEqual(['module.web[0].local_file.page']);
    });

    // A saved plan's move is checked again when read back from the file.
    it('runs a saved plan that moves what is in the module', async () => {
      await apply(once());
      const saved = parsePlanFile(serializePlan(await newOrchestrator().plan(once('1')), once('1'), {}), 'plan.json');

      for await (const event of newOrchestrator().runPlan(saved, once('1'))) if (event.type === 'failed') throw event.error;

      expect(await pages()).toEqual(['site.txt']);
      expect(await stateKeys()).toEqual(['module.web[0].local_file.page']);
    });

    it('moves the first instance back when count is taken off, and destroys the others', async () => {
      await apply(web('2'));

      await apply(once(undefined, 'site-0'));

      expect(await pages()).toEqual(['site-0.txt']);
      expect(await stateKeys()).toEqual(['module.web.local_file.page']);
    });

    it('moves a resource that gains count with its module in one step', async () => {
      await apply(once());
      await writeModule('web', countedPage());

      const { actions } = await newOrchestrator().plan(once('1'));
      expect(actions.map((action) => [Address.of(action).toString(), action.movedFrom])).toEqual([['module.web[0].local_file.page[0]', 'module.web.local_file.page']]);

      await apply(once('1'));
      expect(await pages()).toEqual(['site.txt']);
      expect(await stateKeys()).toEqual(['module.web[0].local_file.page[0]']);
    });

    // Either entry could be the old one; picking one would destroy the other.
    it('refuses to guess when state keeps it in two places it may have been, where the resource is written', async () => {
      await apply(once());
      const state = await new LocalBackend(dir).read();
      state.resources['module.web[0].local_file.page'] = { ...state.resources['module.web.local_file.page'], modulePath: [{ name: 'web', key: 0 }] };
      await new LocalBackend(dir).write(state);
      await writeModule('web', countedPage());

      const error = await planError(once('1'));

      expect(error.message).toBe(
        '"module.web[0].local_file.page[0]" may be "module.web[0].local_file.page" or "module.web.local_file.page" in state, from before count came or went; say which with clay state mv'
      );
      expect(error.position).toMatchObject({ file: 'web/main.clay', ...placeOf(countedPage(), 'resource "local_file" "page"') });
    });
  });
});
