import { CreateRequest, planFromSchema, PlannedChange, PlanRequest, Provider, Schema, UNKNOWN } from '@clay/contracts';
import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { ConfigError } from '@clay/parser';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { start } from './start';

const reversed = (value: unknown) => (Array.isArray(value) ? [...value].reverse() : value);

/** Holds `members`, a set of strings, `order`, a list of them, and `groups`, a set of sets, and plans, makes and reads it in another order than it was given, as a remote API may. */
class PoolProvider implements Provider {
  readonly resources = ['pool'];
  readonly dataSources = ['pool'];

  async getSchema(): Promise<Schema> {
    return {
      id: { type: 'string', computed: true, kept: true },
      members: { type: 'set', elemType: 'string' },
      order: { type: 'list', elemType: 'string' },
      groups: { type: 'set', elemType: 'set' },
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
    return { names: { type: 'list', elemType: 'string', required: true }, members: { type: 'set', elemType: 'string', computed: true } };
  }

  async validateDataSource(): Promise<void> {}

  async readDataSource(_type: string, inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
    return { ...inputs, members: inputs.names };
  }
}

const pool = (members: string) => `resource "pool" "p" { members = ${members} }`;

describe('a set attribute', () => {
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

  afterEach(async () => {
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

  it('holds a member written twice once', async () => {
    await apply(pool('["b", "a", "b"]'));

    expect(await members()).toEqual(['a', 'b']);
  });

  it('is not known while a member is not', async () => {
    const { actions } = await newOrchestrator().plan(`resource "random_string" "r" { length = 4 }\n${pool('["a", random_string.r.result]')}`);

    expect(actions.find((action) => action.resourceType === 'pool')?.after?.members).toBe(UNKNOWN);
  });

  it('applies a member the plan did not know', async () => {
    await apply(`resource "random_string" "r" { length = 4 }\n${pool('["a", random_string.r.result]')}`);

    expect(await members()).toEqual(expect.arrayContaining(['a', expect.stringMatching(/^.{4}$/)]));
  });

  it('is read from a data source in its own order', async () => {
    await apply(`data "pool" "d" { names = ["b", "a"] }\noutput "m" { value = data.pool.d.members }`);

    const { outputs } = await new LocalBackend(dir).read();
    expect(outputs).toEqual({ m: ['a', 'b'] });
  });

  it('refuses a map where it takes a set', async () => {
    await expect(newOrchestrator().plan(pool('{ a = "1" }'))).rejects.toThrow('members is a map, where pool takes a set');
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

  it('goes into a data source as its members in order', async () => {
    await apply(`data "pool" "d" { names = ["b", "a"] }\ndata "pool" "e" { names = data.pool.d.members }\noutput "names" { value = data.pool.e.names }`);

    const { outputs } = await new LocalBackend(dir).read();
    expect(outputs).toEqual({ names: ['a', 'b'] });
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
    expect(outputs).toEqual({ g: [['a', 'b'], ['c']] });
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
});
