import { CreateRequest, ExactNumber, planFromSchema, PlannedChange, PlanRequest, Provider, Schema, types, UNKNOWN } from '@clay/contracts';
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

/** Holds `members`, a set of strings, and makes its id at the apply. */
class PoolProvider implements Provider {
  readonly resources = ['pool'];
  readonly dataSources = [];

  async getSchema(): Promise<Schema> {
    return { id: { type: types.string, computed: true, kept: true }, members: { type: types.set(types.string) } };
  }

  async plan(_type: string, request: PlanRequest): Promise<PlannedChange> {
    return planFromSchema(await this.getSchema(), request);
  }

  async validate(): Promise<void> {}

  async read(_type: string, prior: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    return prior;
  }

  async create(_type: string, { planned }: CreateRequest): Promise<Record<string, unknown>> {
    return { ...planned, id: 'pool' };
  }

  async update(_type: string, { planned }: CreateRequest): Promise<Record<string, unknown>> {
    return planned;
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

/** The line and column `needle` is first written at, as an error would point at it. */
const placeOf = (config: string, needle: string) => {
  const before = config.slice(0, config.indexOf(needle)).split('\n');
  return { line: before.length, column: before.at(-1)!.length + 1 };
};

const names = 'variable "names" { default = ["a", "b"] }';

describe('a function call', () => {
  let dir: string;

  const newOrchestrator = () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    engine.registerProvider(new PoolProvider());
    return engine;
  };

  const apply = async (config: string) => {
    for await (const event of start(newOrchestrator(), config)) if (event.type === 'failed') throw event.error;
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

  const file = (name: string, content: string, count = '') => `resource "local_file" "${name}" {${count}\n  path = "${path.join(dir, name)}.txt"\n  content = ${content}\n}`;

  const read = (name: string) => fs.readFile(path.join(dir, `${name}.txt`), 'utf8');

  const outputs = async () => {
    const state = await new LocalBackend(dir).read();
    return state.outputs;
  };

  const textFiles = async () => {
    const found = await fs.readdir(dir);
    return found.filter((name) => name.endsWith('.txt')).sort();
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-call-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('makes as many instances as length counts', async () => {
    await apply(`${names}
      resource "local_file" "f" {
        count = length(var.names)
        path = "${path.join(dir, 'f-${count.index}.txt')}"
        content = "x"
      }
    `);

    expect(await textFiles()).toEqual(['f-0.txt', 'f-1.txt']);
  });

  it('joins what a call gives into a string', async () => {
    await apply(`${names}\n${file('f', '"total ${length(var.names)}, ${length({ a = 1 })} map"')}`);

    expect(await read('f')).toBe('total 2, 1 map');
  });

  it('gives a number, in an output and as a string that holds only the call', async () => {
    await apply(`${names}\noutput "n" { value = length(var.names) }\noutput "s" { value = "\${length(var.names)}" }`);

    const two = { value: ExactNumber.parse('2'), type: types.number };
    expect(await outputs()).toEqual({ n: two, s: two });
  });

  it('counts the members of a set once each', async () => {
    await apply(`resource "pool" "p" { members = ["a", "b", "a"] }\n${file('f', '"${length(pool.p.members)}"')}`);

    expect(await read('f')).toBe('2');
  });

  it.each([
    ['a name no function has', 'lenght(var.names)', 'lenght(var.names)', 'There is no function "lenght"'],
    ['no argument', 'length()', 'length()', 'length takes 1 argument, not 0'],
    ['an argument too many', 'length(var.names, var.names)', 'length(var.names, var.names)', 'length takes 1 argument, not 2'],
    ['a number', 'length(5)', '5)', 'length takes a string, a list, a tuple, a set, a map or an object, not a number'],
    ['null', 'length(null)', 'null)', 'length takes a string, a list, a tuple, a set, a map or an object, not null'],
    ['a step into the number it gives', 'length(var.names)[0]', 'length(var.names)[0]', 'length(...) is a number and cannot be read into'],
  ])('refuses %s where it is written', async (_name, call, needle, message) => {
    const config = `${names}\noutput "n" {\n  value = ${call}\n}`;

    const error = await planError(config);

    expect(error.message).toBe(message);
    expect(error.position).toMatchObject(placeOf(config, needle));
    expect(error.block).toBe('output "n"');
  });

  it('refuses a name no function has in a module nothing is made of', async () => {
    await fs.mkdir(path.join(dir, 'empty'));
    const module = 'output "n" {\n  value = lenght("abc")\n}';
    await fs.writeFile(path.join(dir, 'empty', 'main.clay'), module, 'utf8');

    const error = await planError('module "empty" {\n  source = "./empty"\n  count = 0\n}');

    expect(error.message).toBe('There is no function "lenght"');
    expect(error.position).toMatchObject({ file: path.join('empty', 'main.clay'), ...placeOf(module, 'lenght') });
  });

  it('refuses a name no function has inside the argument of another, in a module nothing is made of', async () => {
    await fs.mkdir(path.join(dir, 'empty'));
    const module = 'output "n" {\n  value = length(lenght("abc"))\n}';
    await fs.writeFile(path.join(dir, 'empty', 'main.clay'), module, 'utf8');

    const error = await planError('module "empty" {\n  source = "./empty"\n  count = 0\n}');

    expect(error.message).toBe('There is no function "lenght"');
    expect(error.position).toMatchObject(placeOf(module, 'lenght'));
  });

  it('refuses a name no function has in a data source before reading what its argument names', async () => {
    const config = 'data "local_file" "d" {\n  path = lenght(var.nope)\n}';

    const error = await planError(config);

    expect(error.message).toBe('There is no function "lenght"');
    expect(error.position).toMatchObject(placeOf(config, 'lenght'));
  });

  it('knows the length of a list while one of its items is not known', async () => {
    const config = `resource "random_string" "s" { length = 4 }
      resource "local_file" "f" {
        count = length(["z", random_string.s.id])
        path = "${path.join(dir, 'f-${count.index}.txt')}"
        content = "x"
      }
    `;

    const { actions } = await newOrchestrator().plan(config);

    expect(actions.map((action) => action.key)).toEqual([undefined, 0, 1]);
  });

  const unsized = 'resource "pool" "q" { members = [] }\nresource "pool" "p" { members = ["z", pool.q.id] }';

  it('does not know the length of a set while one of its members is not known', async () => {
    const config = `${unsized}\noutput "n" { value = length(pool.p.members) }`;

    const plan = await newOrchestrator().plan(config);
    await apply(config);

    expect(plan.outputs.n.new).toEqual({ value: UNKNOWN, type: types.number });
    expect(await outputs()).toEqual({ n: { value: ExactNumber.parse('2'), type: types.number } });
  });

  it('refuses a count that is the length of such a set', async () => {
    const config = `${unsized}\nresource "local_file" "f" {\n  count = length(pool.p.members)\n  path = "f"\n  content = "x"\n}`;

    const error = await planError(config);

    expect(error.message).toBe('count must be known when planning: it reads a value only an apply makes');
    expect(error.position).toMatchObject(placeOf(config, 'length(pool'));
  });

  it('gives the length of a value only the apply makes once it is made', async () => {
    const config = `resource "random_string" "s" { length = 7 }\n${file('f', '"${length(random_string.s.result)} long"')}\noutput "n" { value = length(random_string.s.result) }`;

    const plan = await newOrchestrator().plan(config);
    await apply(config);

    expect(plan.outputs.n.new).toEqual({ value: UNKNOWN, type: types.number });
    expect(await read('f')).toBe('7 long');
  });

  it('runs a saved plan whose values call a function', async () => {
    const config = `variable "lists" { default = [["a"], ["b", "c", "d"]] }\n${file('f', '"${length(var.lists[1])} items"')}`;
    const saved = parsePlanFile(serializePlan(await newOrchestrator().plan(config), config, {}), 'plan.json');

    for await (const event of newOrchestrator().runPlan(saved, config)) if (event.type === 'failed') throw event.error;

    expect(await read('f')).toBe('3 items');
  });
});
