import { CreateRequest, planFromSchema, PlannedChange, PlanRequest, Provider, Schema, types, UNKNOWN } from '@clay/contracts';
import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { ConfigError } from '@clay/parser';
import { parsePlanFile, serializePlan } from '@clay/planner';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { displayPlan } from '../../src/showPlan';
import { start } from './start';

const reversed = (value: unknown) => (Array.isArray(value) ? [...value].reverse() : value);

/** Holds `members`, a set of strings, `order`, a list of them, and `groups`, a set of sets, and plans, makes and reads it in another order than it was given, as a remote API may. */
class PoolProvider implements Provider {
  readonly resources = ['pool'];
  readonly dataSources = ['pool'];

  async getSchema(): Promise<Schema> {
    return {
      id: { type: types.string, computed: true, kept: true },
      members: { type: types.set(types.string) },
      order: { type: types.list(types.string) },
      groups: { type: types.set(types.set(types.dynamic)) },
    };
  }

  async plan(_type: string, request: PlanRequest): Promise<PlannedChange> {
    const change = planFromSchema(await this.getSchema(), request);
    return { ...change, after: { ...change.after, members: reversed(change.after.members) } };
  }

  async validate(): Promise<void> {}

  async read(_type: string, prior: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    return { ...prior, members: reversed(prior.members) };
  }

  async create(_type: string, { planned }: CreateRequest): Promise<Record<string, unknown>> {
    return { ...planned, id: 'pool', members: reversed(planned.members) };
  }

  async update(_type: string, { planned }: CreateRequest): Promise<Record<string, unknown>> {
    return { ...planned, members: reversed(planned.members) };
  }

  async delete(): Promise<void> {}

  async getDataSourceSchema(): Promise<Schema> {
    return { names: { type: types.list(types.string), required: true }, members: { type: types.set(types.string), computed: true } };
  }

  async validateDataSource(): Promise<void> {}

  async readDataSource(_type: string, inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
    return { ...inputs, members: inputs.names };
  }
}

/** Reads `a` gone and `x` added, as if someone changed the members outside Clay. */
class ChangedPool extends PoolProvider {
  override async read(type: string, prior: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const read = await super.read(type, prior);
    const members = Array.isArray(read?.members) ? read.members.filter((member) => member !== 'a') : [];
    return { ...read, members: [...members, 'x'] };
  }
}

/** Plans `groups` in another order than it was given. */
class RegroupingPool extends PoolProvider {
  override async plan(type: string, request: PlanRequest): Promise<PlannedChange> {
    const change = await super.plan(type, request);
    return { ...change, after: { ...change.after, groups: reversed(change.after.groups) } };
  }
}

const pool = (members: string) => `resource "pool" "p" { members = ${members} }`;

const withOutput = (members: string) => `${pool(members)}\noutput "m" { value = pool.p.members }`;

/** A pool with its members and its order, and an output that reads `attribute`, one or the other. */
const reading = (attribute: string, members: string, order: string) =>
  `resource "pool" "p" {\n  members = ${members}\n  order = ${order}\n}\noutput "m" { value = pool.p.${attribute} }`;

describe('a set attribute', () => {
  let dir: string;

  const newOrchestrator = (poolProvider: Provider = new PoolProvider()) => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    engine.registerProvider(poolProvider);
    return engine;
  };

  const apply = async (config: string) => {
    for await (const event of start(newOrchestrator(), config)) if (event.type === 'failed') throw event.error;
  };

  const file = (content: string) => `resource "local_file" "f" { path = "${path.join(dir, 'f.txt')}" content = ${content} }`;

  const planError = async (config: string): Promise<ConfigError> => {
    try {
      await newOrchestrator().plan(config);
    } catch (error) {
      if (error instanceof ConfigError) return error;

      throw error;
    }

    throw new Error('the plan was made');
  };

  const members = async () => {
    const { resources } = await new LocalBackend(dir).read();
    return resources['pool.p'].attributes.members;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-set-order-'));
    await fs.mkdir(path.join(dir, 'm'));
  });

  /** Plans, saves the plan to a file and reads it back, as `apply plan.json` would, and returns what the CLI prints for it. */
  const shown = async (config: string, poolProvider?: Provider) => {
    const saved = parsePlanFile(serializePlan(await newOrchestrator(poolProvider).plan(config), config, {}), 'plan.json');
    const printed: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => printed.push(stripVTControlCharacters(args.join(' '))));
    displayPlan(saved);
    return printed.join('\n').split('\n');
  };

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('plans nothing when its members are written in another order', async () => {
    await apply(pool('["a", "b"]'));

    const { actions } = await newOrchestrator().plan(pool('["b", "a"]'));

    expect(actions.map((action) => action.type)).toEqual(['NO_OP']);
  });

  // The provider returns the members reversed; a list compared in order failed the apply as a provider bug, and every read planned an update.
  it('takes members a provider returns in another order, and plans nothing after', async () => {
    await apply(pool('["a", "b", "c"]'));

    expect(await members()).toEqual(['a', 'b', 'c']);
    const { actions } = await newOrchestrator().plan(pool('["a", "b", "c"]'));
    expect(actions.map((action) => action.type)).toEqual(['NO_OP']);
  });

  // Only create reached the provider's answer before; an update hands it back reversed too.
  it('takes members an update returns in another order, and plans nothing after', async () => {
    await apply(pool('["a", "b"]'));

    await apply(pool('["a", "b", "c"]'));

    expect(await members()).toEqual(['a', 'b', 'c']);
    const { actions } = await newOrchestrator().plan(pool('["a", "b", "c"]'));
    expect(actions.map((action) => action.type)).toEqual(['NO_OP']);
  });

  // The provider spreads what it was given and names `members` again, so one left out comes back as a key with no value.
  it('takes a name a provider gives no value as one it left out', async () => {
    await apply('resource "pool" "p" { order = ["a"] }');

    const { resources } = await new LocalBackend(dir).read();
    expect(resources['pool.p'].attributes).toEqual({ id: 'pool', order: ['a'] });
  });

  it('holds a member written twice once', async () => {
    await apply(pool('["b", "a", "b"]'));

    expect(await members()).toEqual(['a', 'b']);
  });

  // A member not known yet may come to any value, so the set keeps the members it knows, and that one after them.
  it('keeps a set whose member is not known yet, with the members it knows', async () => {
    const { actions } = await newOrchestrator().plan(`resource "random_string" "r" { length = 4 }\n${pool('[random_string.r.result, "a"]')}`);

    expect(actions.find((action) => action.resourceType === 'pool')?.after?.members).toEqual(['a', UNKNOWN]);
  });

  // pool.q's id is "pool" once made, which p already has; the set then holds one member where the plan showed two.
  it('applies a member the plan did not know that comes to one it has', async () => {
    await apply(`resource "pool" "q" { members = [] }\n${pool('[pool.q.id, "pool"]')}`);

    expect(await members()).toEqual(['pool']);
  });

  // pool.q's id sorts before "z" once made, so a member is compared by what it is, not by where it sorts.
  it('applies, from a saved plan, a member the plan did not know that sorts before one it knew', async () => {
    const config = `resource "pool" "q" { members = [] }\n${pool('["z", pool.q.id]')}`;
    const saved = parsePlanFile(serializePlan(await newOrchestrator().plan(config), config, {}), 'plan.json');

    for await (const event of newOrchestrator().runPlan(saved, config)) if (event.type === 'failed') throw event.error;

    expect(await members()).toEqual(['pool', 'z']);
  });

  // Neither group is known whole, so neither can be put in order by what it holds once made; they are still held in one order.
  it('takes members known in part that a provider plans in another order', async () => {
    const config = `resource "pool" "q" {\n  members = []\n  groups = []\n}\nresource "pool" "p" {\n  members = []\n  groups = [["z", pool.q.id], ["a", pool.q.id]]\n}`;

    const { actions } = await newOrchestrator(new RegroupingPool()).plan(config);

    expect(actions.find((action) => action.name === 'p')?.after?.groups).toEqual([
      ['a', UNKNOWN],
      ['z', UNKNOWN],
    ]);
  });

  it('refuses for_each over a set with a member not known yet', async () => {
    const error = await planError(
      `resource "random_string" "r" { length = 4 }\n${pool('["a", random_string.r.result]')}\nresource "null_resource" "n" { for_each = pool.p.members }`
    );

    expect(error.message).toBe('for_each must be known when planning: a member reads a value only an apply makes, and a set names its instances by its members');
  });

  it('applies a member the plan did not know', async () => {
    await apply(`resource "random_string" "r" { length = 4 }\n${pool('["a", random_string.r.result]')}`);

    expect(await members()).toEqual(expect.arrayContaining(['a', expect.stringMatching(/^.{4}$/)]));
  });

  it('is read from a data source in its own order', async () => {
    await apply(`data "pool" "d" { names = ["b", "a"] }\noutput "m" { value = data.pool.d.members }`);

    const { outputs } = await new LocalBackend(dir).read();
    expect(outputs).toEqual({ m: { value: ['a', 'b'], type: types.set(types.string) } });
  });

  it('refuses a map where it takes a set', async () => {
    await expect(newOrchestrator().plan(pool('{ a = "1" }'))).rejects.toThrow('members is an object, where pool takes a set');
  });

  // The members are held sorted, so an index reads whichever sorts first, and another member added moves it.
  it('refuses an index into it, where it is written', async () => {
    const error = await planError(`${pool('["web", "api"]')}\n${file('pool.p.members[0]')}`);

    expect(error.message).toBe('pool.p.members is a set and has no item [0]: its members have no order');
    expect(error.position).toMatchObject({ line: 2 });
  });

  it('refuses an index into one in state', async () => {
    await apply(pool('["web", "api"]'));

    const error = await planError(`${pool('["web", "api"]')}\n${file('pool.p.members[0]')}`);

    expect(error.message).toBe('pool.p.members is a set and has no item [0]: its members have no order');
  });

  it('refuses a key into it', async () => {
    const error = await planError(`${pool('["web", "api"]')}\n${file('pool.p.members["web"]')}`);

    expect(error.message).toBe('pool.p.members is a set and has no key "web"');
  });

  it('refuses an index into one a data source reads', async () => {
    const error = await planError(`data "pool" "d" { names = ["b", "a"] }\n${file('data.pool.d.members[0]')}`);

    expect(error.message).toBe('data.pool.d.members is a set and has no item [0]: its members have no order');
    expect(error.position).toMatchObject({ line: 2 });
  });

  // The schema stays behind at the module call; the value has to say what it is on its own.
  it('refuses an index into one a module input carries', async () => {
    await fs.writeFile(path.join(dir, 'm', 'main.clay'), `variable "members" {}\n${file('var.members[0]')}`, 'utf8');

    const error = await planError(`${pool('["web", "api"]')}\nmodule "m" { source = "./m" members = pool.p.members }`);

    expect(error.message).toBe('var.members is a set and has no item [0]: its members have no order');
    expect(error.position).toMatchObject({ line: 2 });
  });

  it('refuses an index into one a module output carries', async () => {
    await fs.writeFile(path.join(dir, 'm', 'main.clay'), `${pool('["web", "api"]')}\noutput "members" { value = pool.p.members }`, 'utf8');

    const error = await planError(`module "m" { source = "./m" }\n${file('module.m.members[0]')}`);

    expect(error.message).toBe('module.m.members is a set and has no item [0]: its members have no order');
    expect(error.position).toMatchObject({ line: 2 });
  });

  it('goes where a list is taken as its members in order', async () => {
    await apply(`${pool('["b", "a"]')}\nresource "pool" "q" {\n  members = []\n  order = pool.p.members\n}`);

    const { resources } = await new LocalBackend(dir).read();
    expect(resources['pool.q'].attributes.order).toEqual(['a', 'b']);
  });

  // pool.q's id sorts before "z" once made, so the list has no order to show until the apply knows every member.
  it('applies a list taken from a set whose member the plan did not know', async () => {
    await apply(`resource "pool" "q" { members = [] }\n${pool('["z", pool.q.id]')}\nresource "pool" "o" {\n  members = []\n  order = pool.p.members\n}`);

    const { resources } = await new LocalBackend(dir).read();
    expect(resources['pool.o'].attributes.order).toEqual(['pool', 'z']);
  });

  it('applies a set whose member the plan did not know where any value is taken', async () => {
    await apply(`resource "pool" "q" { members = [] }\n${pool('["z", pool.q.id]')}\nresource "null_resource" "n" { triggers = { m = pool.p.members } }`);

    const { resources } = await new LocalBackend(dir).read();
    expect(resources['null_resource.n'].attributes.triggers).toEqual({ m: ['pool', 'z'] });
  });

  // Its value is not known at plan, but that it will be a string is.
  it('refuses, at plan, a value not known yet of a type the attribute does not take', async () => {
    const error = await planError(`resource "pool" "q" { members = [] }\nresource "pool" "o" {\n  members = []\n  order = pool.q.id\n}`);

    expect(error.message).toBe('order is a string, where pool takes a list');
    expect(error.position).toMatchObject({ line: 4 });
  });

  it('goes into a data source as its members in order', async () => {
    await apply(`data "pool" "d" { names = ["b", "a"] }\ndata "pool" "e" { names = data.pool.d.members }\noutput "names" { value = data.pool.e.names }`);

    const { outputs } = await new LocalBackend(dir).read();
    expect(outputs).toEqual({ names: { value: ['a', 'b'], type: types.list(types.string) } });
  });

  it('plans no change to an output that holds the same members', async () => {
    const config = `${pool('["b", "a"]')}\noutput "m" { value = pool.p.members }`;
    await apply(config);

    const { outputs } = await newOrchestrator().plan(config);

    expect(outputs).toEqual({});
  });

  it('refuses to be joined into a string', async () => {
    const error = await planError(`${pool('["web", "api"]')}\n${file('"members: ${pool.p.members}"')}`);

    expect(error.message).toBe('pool.p.members is a set and cannot be joined into a string');
    expect(error.position).toMatchObject({ line: 2 });
  });

  it('writes a set of sets to state as lists', async () => {
    await apply(`resource "pool" "p" {\n  members = []\n  groups = [["c"], ["b", "a"]]\n}\noutput "g" { value = pool.p.groups }`);

    const { outputs } = await new LocalBackend(dir).read();
    expect(outputs).toEqual({ g: { value: [['a', 'b'], ['c']], type: types.set(types.set(types.dynamic)) } });
  });

  it('gives for_each one instance for each member', async () => {
    await apply(`${pool('["b", "a"]')}\nresource "null_resource" "n" {\n  for_each = pool.p.members\n  triggers = { name = each.value }\n}`);

    const { resources } = await new LocalBackend(dir).read();
    expect(
      Object.keys(resources)
        .filter((key) => key.startsWith('null_resource'))
        .sort()
    ).toEqual(['null_resource.n["a"]', 'null_resource.n["b"]']);
  });

  it('shows the members a plan adds, not the whole set', async () => {
    await apply(pool('["a", "b"]'));

    const lines = await shown(pool('["a", "b", "c"]'));

    expect(lines).toEqual(expect.arrayContaining(['      members:', '        + "c"', '        (2 unchanged)']));
  });

  it('shows a member not known yet as one it adds', async () => {
    await apply(pool('["a", "b"]'));

    const lines = await shown(`resource "random_string" "r" { length = 4 }\n${pool('["a", random_string.r.result]')}`);

    const at = lines.indexOf('      members:');
    expect(lines.slice(at, at + 4)).toEqual(['      members:', '        - "b"', '        + (known after apply)', '        (1 unchanged)']);
  });

  it('shows the members changed outside Clay, removed first', async () => {
    await apply(pool('["a", "b"]'));

    const lines = await shown(pool('["b", "x"]'), new ChangedPool());

    const at = lines.indexOf('  ~ pool.p was changed outside Clay');
    expect(lines.slice(at + 1, at + 5)).toEqual(['      members:', '        - "a"', '        + "x"', '        (1 unchanged)']);
  });

  it('shows the members an output loses and gains, not the whole set', async () => {
    await apply(withOutput('["a", "b"]'));

    const lines = await shown(withOutput('["b", "c"]'));

    const at = lines.indexOf('  ~ m:');
    expect(lines.slice(at, at + 4)).toEqual(['  ~ m:', '      - "a"', '      + "c"', '      (1 unchanged)']);
  });

  it('shows an output that comes to a set whole, having no members before to compare', async () => {
    const lines = await shown(withOutput('["b", "a"]'));

    expect(lines).toContain('  + m = ["a","b"]');
  });

  // The values print the same, so the line would read as no change without the types.
  it('shows an output whose members stay and whose type changes by the types', async () => {
    const config = reading('members', '["a", "b"]', '["a", "b"]');
    await apply(reading('order', '["a", "b"]', '["a", "b"]'));

    const planned = await newOrchestrator().plan(config);
    const lines = await shown(config);

    expect(planned.actions.map((action) => action.type)).toEqual(['NO_OP']);
    expect(lines).toContain('  ~ m = ["a","b"] (list(string) -> set(string))');
  });

  it('shows a list that becomes a set with other members whole, since a list has an order to lose', async () => {
    await apply(reading('order', '["b", "c"]', '["b", "a"]'));

    const lines = await shown(reading('members', '["b", "c"]', '["b", "a"]'));

    expect(lines).toContain('  ~ m = ["b","a"] -> ["b","c"]');
  });

  it('keeps the type of an output through a saved plan and into state', async () => {
    const config = withOutput('["b", "a"]');
    const saved = parsePlanFile(serializePlan(await newOrchestrator().plan(config), config, {}), 'plan.json');

    for await (const event of newOrchestrator().runPlan(saved, config)) if (event.type === 'failed') throw event.error;

    const kept = { value: ['a', 'b'], type: types.set(types.string) };
    expect(saved.outputs).toEqual({ m: { old: undefined, new: kept } });
    const state = await new LocalBackend(dir).read();
    expect(state.outputs).toEqual({ m: kept });
  });
});
