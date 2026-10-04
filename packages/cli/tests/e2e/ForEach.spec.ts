import { types } from '@clay/contracts';
import { DiskFiles, Orchestrator, RunEvent } from '@clay/orchestrator';
import { ConfigError } from '@clay/parser';
import { parsePlanFile, serializePlan } from '@clay/planner';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPlanCommand } from '../../src/commands/plan';
import { createStateCommand } from '../../src/commands/state';
import { start } from './start';

/** The line and column `needle` is first written at, as an error would point at it. */
const placeOf = (config: string, needle: string) => {
  const before = config.slice(0, config.indexOf(needle)).split('\n');
  return { line: before.length, column: before.at(-1)!.length + 1 };
};

describe('a resource with for_each', () => {
  let dir: string;

  const newOrchestrator = () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    return engine;
  };

  /** Applies the config and returns what it did, in order. */
  const apply = async (config: string): Promise<RunEvent[]> => {
    const events: RunEvent[] = [];
    for await (const event of start(newOrchestrator(), config)) {
      if (event.type === 'failed') throw event.error;
      events.push(event);
    }
    return events;
  };

  /** One file for each key, named after the key and holding its value. */
  const files = (forEach: string, content = '${each.value}') => `
    resource "local_file" "f" {
      for_each = ${forEach}
      path = "${path.join(dir, '${each.key}.txt')}"
      content = "${content}"
    }
  `;

  const read = (name: string) => fs.readFile(path.join(dir, name), 'utf8');

  const written = async () => {
    const names = await fs.readdir(dir);
    return names.filter((name) => name.endsWith('.txt')).sort();
  };

  const stateKeys = async () => {
    const state = await new LocalBackend(dir).read();
    return Object.keys(state.resources).sort();
  };

  const planned = async (config: string) => {
    const { actions } = await newOrchestrator().plan(config);
    return actions.map((action) => [action.type, action.name, action.key]);
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

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-for-each-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('makes one of it for each key of a map, each with its own each.key and each.value', async () => {
    await apply(files('{ web = "80", api = "8080" }'));

    expect(await written()).toEqual(['api.txt', 'web.txt']);
    expect(await read('web.txt')).toBe('80');
    expect(await stateKeys()).toEqual(['local_file.f["api"]', 'local_file.f["web"]']);
  });

  it('makes one of it for each string of a list, with the string as both key and value', async () => {
    await apply(files('["a", "b"]', '${each.key}=${each.value}'));

    expect(await written()).toEqual(['a.txt', 'b.txt']);
    expect(await read('b.txt')).toBe('b=b');
  });

  it('reads into each.value', async () => {
    await apply(files('{ web = { port = 80 } }', 'port ${each.value.port}'));

    expect(await read('web.txt')).toBe('port 80');
  });

  // An object lists a key like "1" first, so a plan in the written order would differ from one map to the next.
  it('plans the instances in the order of their keys, whatever order they are written in', async () => {
    expect(await planned(files('{ b = "x", a = "x", "10" = "x" }'))).toEqual([
      ['CREATE', 'f', '10'],
      ['CREATE', 'f', 'a'],
      ['CREATE', 'f', 'b'],
    ]);
    expect(await planned(files('["b", "a"]'))).toEqual([
      ['CREATE', 'f', 'a'],
      ['CREATE', 'f', 'b'],
    ]);
  });

  it('reads for_each from a variable', async () => {
    await apply(`variable "names" { default = ["x", "y"] }\n${files('var.names')}`);

    expect(await written()).toEqual(['x.txt', 'y.txt']);
  });

  it('reads for_each in a module from what the module is called with', async () => {
    await fs.mkdir(path.join(dir, 'm'));
    await fs.writeFile(path.join(dir, 'm', 'main.clay'), `variable "names" {}\n${files('var.names')}`, 'utf8');

    await apply('module "m" { source = "./m" names = { x = "1" } }');

    expect(await read('x.txt')).toBe('1');
    expect(await stateKeys()).toEqual(['module.m.local_file.f["x"]']);
  });

  it('creates only a key it gains and destroys only a key it loses, keeping the rest as they are', async () => {
    await apply(files('["a", "b"]'));

    expect(await planned(files('["b", "c"]'))).toEqual([
      ['NO_OP', 'f', 'b'],
      ['CREATE', 'f', 'c'],
      ['DELETE', 'f', 'a'],
    ]);

    await apply(files('["b", "c"]'));
    expect(await written()).toEqual(['b.txt', 'c.txt']);
  });

  it('destroys every instance when for_each is empty', async () => {
    await apply(files('["a", "b"]'));

    await apply(files('[]'));

    expect(await written()).toEqual([]);
    expect(await stateKeys()).toEqual([]);
  });

  it('gives one instance to a resource and an output that read it, by ["key"] or by .key', async () => {
    const config = `${files('{ web = "80", api = "8080" }')}
      resource "local_file" "reader" {
        path = "${path.join(dir, 'reader.txt')}"
        content = "\${local_file.f["web"].content}"
      }
      output "api" { value = "\${local_file.f.api.content}" }
    `;

    const events = await apply(config);

    expect(await read('reader.txt')).toBe('80');
    expect(events.at(-1)).toEqual({ type: 'done', outputs: { api: { value: '8080', type: types.string } } });
  });

  const withReader = (web: string) => `${files(`{ web = "${web}", api = "8080" }`)}
    resource "local_file" "reader" {
      path = "${path.join(dir, 'reader.txt')}"
      content = "\${local_file.f["api"].content}"
    }
  `;

  // Only the instance that changes is unknown; the one read is in state, so its reader has nothing to change.
  it('plans a reader of an instance that stays as it is with nothing to do, when another instance changes', async () => {
    await apply(withReader('80'));

    expect(await planned(withReader('81'))).toEqual([
      ['NO_OP', 'f', 'api'],
      ['UPDATE', 'f', 'web'],
      ['NO_OP', 'reader', undefined],
    ]);
  });

  it('plans a reader of an instance that changes with the value it changes to', async () => {
    await apply(withReader('80'));

    const plan = await newOrchestrator().plan(withReader('80').replace('"8080"', '"9090"'));

    const reader = plan.actions.find((action) => action.name === 'reader');
    expect(reader?.type).toBe('UPDATE');
    expect(reader?.changes?.content.new).toBe('9090');
  });

  it('deletes a reader before the instances it read', async () => {
    await apply(withReader('80'));

    const events = await apply('');

    const deleted = events.filter((event) => event.type === 'applied').map((event) => (event.type === 'applied' ? event.action.name : ''));
    expect(deleted).toEqual(['reader', 'f', 'f']);
  });

  // No key stands for the resource as count's [0] does, so nothing is moved; `clay state mv` keeps it.
  it.each([
    ['one with neither', '', undefined],
    ['one with count', 'count = 1', 0],
  ])('moves nothing when for_each is added to %s', async (_, head, deleted) => {
    await apply(`resource "local_file" "f" { ${head} path = "${path.join(dir, 'old.txt')}" content = "x" }`);

    expect(await planned(files('["a"]'))).toEqual([
      ['CREATE', 'f', 'a'],
      ['DELETE', 'f', deleted],
    ]);
  });

  it('moves nothing when for_each is taken off', async () => {
    await apply(files('["a"]'));

    expect(await planned(`resource "local_file" "f" { path = "${path.join(dir, 'a.txt')}" content = "a" }`)).toEqual([
      ['CREATE', 'f', undefined],
      ['DELETE', 'f', 'a'],
    ]);
  });

  it('runs a saved plan, giving each instance its each.value', async () => {
    const config = files('{ web = "80", api = "8080" }');
    const saved = parsePlanFile(serializePlan(await newOrchestrator().plan(config), config, {}), 'plan.json');

    for await (const event of newOrchestrator().runPlan(saved, config)) if (event.type === 'failed') throw event.error;

    expect(await read('api.txt')).toBe('8080');
    expect(await stateKeys()).toEqual(['local_file.f["api"]', 'local_file.f["web"]']);
  });

  it('refuses a saved plan whose instances its configuration does not make', async () => {
    const saved = await newOrchestrator().plan(files('["a"]'));
    const without = `resource "local_file" "f" { path = "${path.join(dir, 'a.txt')}" content = "a" }`;

    const run = async () => {
      for await (const event of newOrchestrator().runPlan(saved, without)) if (event.type === 'failed') throw event.error;
    };

    await expect(run()).rejects.toThrow('The plan has "local_file.f["a"]", which the configuration does not declare');
  });

  it.each([
    ['a key its for_each does not give', (key: string | number) => (key === 'b' ? 'gone' : key), 'The plan has "local_file.f["gone"]", which the configuration does not declare'],
    ['an index where its for_each gives keys', (key: string | number) => (key === 'b' ? 1 : key), 'The plan has "local_file.f[1]", which the configuration does not declare'],
  ])('refuses a saved plan with %s, before that instance runs', async (_, rekey, message) => {
    const config = files('["a", "b"]');
    const saved = await newOrchestrator().plan(config);
    for (const action of saved.actions) action.key = rekey(action.key!);

    const run = async () => {
      for await (const event of newOrchestrator().runPlan(saved, config)) if (event.type === 'failed') throw event.error;
    };

    await expect(run()).rejects.toThrow(message);
    expect(await written()).toEqual([]);
  });

  it.each([
    ['all of it where one is read', 'local_file.f[0].content', 'local_file.f has for_each, so name one of it by key, as in local_file.f["key"]'],
    [
      'an attribute where the key goes',
      'local_file.f.content',
      'Reference "local_file.f.content" names an instance and no attribute: local_file.f has for_each, so its key comes first, as in local_file.f["key"].id',
    ],
    ['a key its for_each does not give', 'local_file.f["gone"].content', 'local_file.f has no instance ["gone"], only ["a"], ["b"]'],
  ])('refuses a reference to %s, where it is written', async (_, reference, message) => {
    const config = `${files('["a", "b"]')}
      output "o" { value = "\${${reference}}" }
    `;

    const error = await planError(config);

    expect(error.message).toContain(message);
    expect(error.position).toMatchObject(placeOf(config, reference));
  });

  it.each([
    ['a resource that has neither', 'resource "local_file" "a" { path = "a" content = "${each.key}" }', 'each.key'],
    ['a resource that has count', 'resource "local_file" "a" { count = 1 path = "a" content = "${each.value}" }', 'each.value'],
    ['an output', 'output "o" { value = "${each.key}" }', 'each.key'],
    ['a variable', 'variable "v" { default = "${each.value}" }', 'each.value'],
    ['the for_each it would come from', 'resource "local_file" "a" { for_each = ["${each.key}"] path = "a" content = "a" }', 'each.key'],
    ['a data source', 'data "local_file" "d" { path = "${each.key}" }', 'each.key'],
    // The output is not read at plan time, since it waits on a value only an apply makes.
    ['an output that also reads a value still to come', 'resource "random_string" "s" { length = 4 }\noutput "o" { value = "${each.key}-${random_string.s.id}" }', 'each.key'],
  ])('refuses each in %s, where it is written', async (_, config, reference) => {
    const error = await planError(config);

    expect(error.message).toBe(`${reference} is only known inside a resource or a module call that has for_each`);
    expect(error.position).toMatchObject(placeOf(config, reference));
  });

  it('refuses count.index in a resource that has for_each, where it is written', async () => {
    const config = files('["a"]', '${count.index}');

    const error = await planError(config);

    expect(error.message).toBe('count.index is only known inside a resource or a module call that has count');
    expect(error.position).toMatchObject(placeOf(config, 'count.index'));
  });

  it('refuses a for_each that reads a resource the configuration does not declare', async () => {
    const config = files('local_file.nowhere.id');

    const error = await planError(config);

    expect(error.message).toBe('"local_file.nowhere" is not declared in the configuration');
    expect(error.position).toMatchObject(placeOf(config, 'local_file.nowhere'));
  });

  it.each([
    ['a string', '"a"', 'for_each is a map, or a list or a set of strings, not a string'],
    ['a list with a number in it', '["a", 1]', 'for_each is a list of strings, but item [1] is a number'],
    ['a list with a string twice', '["a", "b", "a"]', 'for_each holds "a" twice; each instance needs a key of its own'],
    ['a value only an apply makes', 'random_string.s.id', 'for_each must be known when planning: it reads a value only an apply makes'],
    // A list's items are its keys, so one still to come leaves an instance without a name.
    [
      'a list with an item only an apply makes',
      '["a", random_string.s.id]',
      'for_each must be known when planning: item [1] reads a value only an apply makes, and a list names its instances by its items',
    ],
  ])('refuses a for_each that is %s, where it is written', async (_, forEach, message) => {
    const config = `resource "random_string" "s" { length = 4 }\n${files(forEach)}`;

    const error = await planError(config);

    expect(error.message).toBe(message);
    expect(error.position).toMatchObject(placeOf(config, forEach));
  });
});

// The commands read the current directory, so they run from a temp one.
describe('how the CLI shows a resource with for_each', () => {
  let dir: string;
  let cwd: string;
  let printed: string[];

  const write = (config: string) => fs.writeFile(path.join(dir, 'main.clay'), config, 'utf8');
  const file = (head: string) => `resource "local_file" "f" { ${head} path = "${path.join(dir, 'f.txt')}" content = "x" }`;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-for-each-cli-'));
    cwd = process.cwd();
    process.chdir(dir);
    printed = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => printed.push(args.join(' ')));
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.chdir(cwd);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('names each instance by its key', async () => {
    await write(file('for_each = ["web"]'));

    await createPlanCommand().parseAsync(['node', 'clay']);

    expect(printed.join('\n')).toContain('+ local_file.f["web"] will be created');
  });

  it('keeps a resource that gains for_each once state mv moves it to a key', async () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    for await (const event of start(engine, file(''))) if (event.type === 'failed') throw event.error;

    await createStateCommand().parseAsync(['node', 'state', 'mv', 'local_file.f', 'local_file.f["web"]']);
    await write(file('for_each = ["web"]'));
    printed.length = 0;
    await createPlanCommand().parseAsync(['node', 'clay']);

    expect(printed.join('\n')).toContain('No changes.');
  });
});
