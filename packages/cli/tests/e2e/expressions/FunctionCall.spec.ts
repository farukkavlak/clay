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

import { start } from '../start';

/** Holds `members`, a set of strings, and computes its id at apply. */
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

/** Where an error would point at the first `needle`. */
const placeOf = (config: string, needle: string) => {
  const before = config.slice(0, config.indexOf(needle)).split('\n');
  return { line: before.length, column: before.at(-1)!.length + 1 };
};

const names = 'variable "names" { default = ["a", "b"] }';

const portRule = (ports: string) =>
  `variable "ports" {\n  default = ${ports}\n  validation {\n    condition     = alltrue([for p in var.ports : p > 0]) && anytrue([for p in var.ports : p == 443])\n    error_message = "bad ports"\n  }\n}`;

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
    ['join with nothing to join', 'join("-")', 'join("-")', 'join takes at least 2 arguments, not 1'],
    ['upper of a list', 'upper(var.names)', 'var.names)', 'upper takes a string, not a tuple'],
    ['join of a map after a list', 'join("-", var.names, { a = "x" })', '{ a = "x" })', 'join takes lists of strings after the separator, not an object'],
    ['lookup with no default', 'lookup({ a = "x" }, "a")', 'lookup(', 'lookup takes 3 arguments, not 2; without a default, read the key with map["key"]'],
    ['lookup in a list', 'lookup(var.names, "a", "x")', 'var.names, "a"', 'lookup takes a map or an object, not a tuple'],
    ['merge of a list', 'merge({ a = "x" }, var.names)', 'var.names)', 'merge takes maps or objects, not a tuple'],
    [
      'format with a verb it does not take',
      'format("%z")',
      '"%z")',
      'format cannot read "%z": there is no verb %z; format takes %s, %q, %v, %t, %d, %b, %o, %x, %X, %f, %e, %E, %g, %G and %%',
    ],
    ['format of a list as a string', 'format("%s", var.names)', 'var.names)', 'format cannot write a tuple with "%s"'],
    ['format with an argument it does not use', 'format("%s", "a", "b")', '"b")', "format's string has no verb for this argument"],
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

  it('reads a member of a set by its place in a list', async () => {
    await apply(`resource "pool" "p" { members = ["b", "a"] }\n${file('f', 'tolist(pool.p.members)[1]')}`);

    expect(await read('f')).toBe('b');
  });

  it('makes an instance for each member toset keeps', async () => {
    await apply(`
      resource "local_file" "f" {
        for_each = toset(["b", "a", "b"])
        path = "${path.join(dir, 'f-${each.key}.txt')}"
        content = each.value
      }
    `);

    expect(await textFiles()).toEqual(['f-a.txt', 'f-b.txt']);
  });

  it('gives a list of a set whose member is not known once the apply knows it', async () => {
    const config = `${unsized}\noutput "l" { value = tolist(pool.p.members) }`;

    const plan = await newOrchestrator().plan(config);
    await apply(config);

    expect(plan.outputs.l.new).toEqual({ value: UNKNOWN, type: types.list(types.string) });
    expect(await outputs()).toEqual({ l: { value: ['pool', 'z'], type: types.list(types.string) } });
  });

  it('refuses items with no type in common where the argument is written', async () => {
    const config = 'output "l" {\n  value = tolist([1, true])\n}';

    const error = await planError(config);

    expect(error.message).toBe('tolist cannot join a number and a boolean into one type');
    expect(error.position).toMatchObject(placeOf(config, '[1, true]'));
  });

  it('writes what upper, lower and join give', async () => {
    await apply(`${names}\n${file('f', 'join(", ", [upper("a"), lower("B")], var.names, [3])')}`);

    expect(await read('f')).toBe('A, b, a, b, 3');
  });

  it('gives join of a value only the apply makes once it is made', async () => {
    const config = `resource "random_string" "s" { length = 4 }\noutput "j" { value = join("-", ["id", length(random_string.s.result)]) }`;

    const plan = await newOrchestrator().plan(config);
    await apply(config);

    expect(plan.outputs.j.new).toEqual({ value: UNKNOWN, type: types.string });
    expect(await outputs()).toEqual({ j: { value: 'id-4', type: types.string } });
  });

  it('keeps the string join and upper make sensitive where what they read is', async () => {
    const config = `variable "token" {\n  default   = "t"\n  sensitive = true\n}\n${names}\noutput "j" {\n  value = join("-", var.names, [upper(var.token)])\n}`;

    const error = await planError(config);

    expect(error.message).toBe('output "j" holds a sensitive value; write sensitive = true to export it');
  });

  it('writes what lookup and merge give', async () => {
    const config = `locals {
  common = { team = "web", env = "dev" }
  tags   = merge(local.common, { env = "prod" })
}
${file('f', '"${local.tags.team}-${local.tags.env}-${lookup(local.tags, "zone", "none")}"')}`;

    await apply(config);

    expect(await read('f')).toBe('web-prod-none');
  });

  it('makes an instance for each key merge gives', async () => {
    await apply(`
      resource "local_file" "f" {
        for_each = merge({ a = "1", b = "2" }, { b = "3" })
        path = "${path.join(dir, 'f-${each.key}.txt')}"
        content = each.value
      }
    `);

    expect(await textFiles()).toEqual(['f-a.txt', 'f-b.txt']);
    expect(await read('f-b')).toBe('3');
  });

  it('keeps sensitive only the part merge keeps from a sensitive value', async () => {
    const config = `variable "token" {\n  default   = "t"\n  sensitive = true\n}\noutput "o" {\n  value = merge({ a = var.token, b = "x" }, { a = "y" })\n}`;

    await apply(config);

    expect(await outputs()).toEqual({ o: { value: { a: 'y', b: 'x' }, type: types.object({ a: types.string, b: types.string }) } });
  });

  it('keeps sensitive what lookup reads at a sensitive key', async () => {
    const config = `variable "key" {\n  default   = "a"\n  sensitive = true\n}\noutput "o" {\n  value = lookup({ a = "x" }, var.key, "none")\n}`;

    const error = await planError(config);

    expect(error.message).toBe('output "o" holds a sensitive value; write sensitive = true to export it');
  });

  it('refuses at validate a default no value of the map joins with', async () => {
    const config = 'variable "m" {\n  type    = map(string)\n  default = { a = "x" }\n}\noutput "o" {\n  value = lookup(var.m, "a", ["x"])\n}';

    await expect(newOrchestrator().validate(config)).rejects.toMatchObject({
      message: 'lookup cannot join a string and a tuple into one type',
      position: placeOf(config, '["x"]'),
    });
  });

  it('writes what format gives', async () => {
    await apply(`locals {\n  n = 7\n}\n${file('f', '"${format("%s-%03d %q %v", "web", local.n, "a", { b = 1 })}"')}`);

    expect(await read('f')).toBe('web-007 "a" {"b":1}');
  });

  it('writes numbers with the number verbs of format', async () => {
    await apply(`locals {\n  n = 2.675\n}\n${file('f', '"${format("%.2f %.1e %g %#x", local.n, 1234, 0.00001, 255)}"')}`);

    expect(await read('f')).toBe('2.68 1.2e+03 1e-05 0xff');
  });

  it('names one file per instance with format', async () => {
    await apply(`
      resource "local_file" "f" {
        count = 2
        path = format("%s/f-%02d.txt", "${dir}", count.index + 1)
        content = "x"
      }
    `);

    expect(await textFiles()).toEqual(['f-01.txt', 'f-02.txt']);
  });

  it('keeps sensitive what format writes from a sensitive value', async () => {
    const config = `variable "token" {\n  default   = "t"\n  sensitive = true\n}\noutput "o" {\n  value = format("Bearer %s", var.token)\n}`;

    const error = await planError(config);

    expect(error.message).toBe('output "o" holds a sensitive value; write sensitive = true to export it');
  });

  it('refuses at validate a value format cannot write before it is known', async () => {
    const config = 'resource "random_string" "s" { length = 4 }\noutput "o" {\n  value = format("%s", [random_string.s.result])\n}';

    await expect(newOrchestrator().validate(config)).rejects.toMatchObject({
      message: 'format cannot write a tuple with "%s"',
      position: placeOf(config, '[random_string.s.result])'),
    });
  });

  it('refuses at validate a list of lists to join before what it holds is known', async () => {
    const config = 'resource "random_string" "s" { length = 4 }\noutput "j" {\n  value = join("-", [[random_string.s.result]])\n}';

    await expect(newOrchestrator().validate(config)).rejects.toMatchObject({
      message: 'join takes lists of strings, and this one holds a tuple',
      position: placeOf(config, '[[random'),
    });
  });

  it('holds a variable to a rule over its list with alltrue and anytrue', async () => {
    const counted = file('f', '"${length(var.ports)}"');

    await apply(`${portRule('[80, 443]')}\n${counted}`);
    await expect(apply(`${portRule('[80, 0]')}\n${counted}`)).rejects.toMatchObject({ message: expect.stringContaining('bad ports') });

    expect(await read('f')).toBe('2');
  });

  it('decides alltrue at plan by a false item beside one only the apply makes', async () => {
    const config = 'resource "random_string" "s" { length = 4 }\noutput "all" { value = alltrue([random_string.s.result == "x", false]) }';

    const plan = await newOrchestrator().plan(config);

    expect(plan.outputs.all.new).toEqual({ value: false, type: types.bool });
  });

  it('refuses at validate a list of numbers to alltrue before what it holds is known', async () => {
    const config = 'resource "random_string" "s" { length = 4 }\noutput "a" {\n  value = alltrue([length(random_string.s.result)])\n}';

    await expect(newOrchestrator().validate(config)).rejects.toMatchObject({
      message: 'alltrue takes a list of booleans, and this one holds a number',
      position: placeOf(config, '[length'),
    });
  });

  it('refuses an object of no declared type to anytrue', async () => {
    const config = 'variable "v" { default = { a = true } }\noutput "a" {\n  value = anytrue(var.v)\n}';

    await expect(newOrchestrator().validate(config)).rejects.toMatchObject({
      message: 'anytrue takes a list of booleans, not an object',
      position: placeOf(config, 'var.v)'),
    });
  });

  it('runs a saved plan that reads into what a function gives', async () => {
    const config = `variable "v" { default = ["b", "a", "b"] }\n${file('f', 'tolist(toset(var.v))[0]')}`;
    const saved = parsePlanFile(serializePlan(await newOrchestrator().plan(config), config, {}), 'plan.json');

    for await (const event of newOrchestrator().runPlan(saved, config)) if (event.type === 'failed') throw event.error;

    expect(await read('f')).toBe('a');
  });

  it('runs a saved plan whose values call a function', async () => {
    const config = `variable "lists" { default = [["a"], ["b", "c", "d"]] }\n${file('f', '"${length(var.lists[1])} items"')}`;
    const saved = parsePlanFile(serializePlan(await newOrchestrator().plan(config), config, {}), 'plan.json');

    for await (const event of newOrchestrator().runPlan(saved, config)) if (event.type === 'failed') throw event.error;

    expect(await read('f')).toBe('3 items');
  });
});
