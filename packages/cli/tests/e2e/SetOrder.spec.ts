import { CreateRequest, planFromSchema, PlannedChange, PlanRequest, Provider, Schema, UNKNOWN } from '@clay/contracts';
import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { start } from './start';

const reversed = (value: unknown) => (Array.isArray(value) ? [...value].reverse() : value);

/** Holds `members`, a set of strings, and plans, makes and reads it in another order than it was given, as a remote API may. */
class PoolProvider implements Provider {
  readonly resources = ['pool'];
  readonly dataSources = ['pool'];

  async getSchema(): Promise<Schema> {
    return { id: { type: 'string', computed: true, kept: true }, members: { type: 'set', elemType: 'string' } };
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

  const members = async () => {
    const { resources } = await new LocalBackend(dir).read();
    return resources['pool.p'].attributes.members;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-set-order-'));
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
    await apply(`data "pool" "d" { names = ["b", "a"] }\nresource "pool" "p" { members = data.pool.d.members }`);

    expect(await members()).toEqual(['a', 'b']);
  });

  it('refuses a map where it takes a set', async () => {
    await expect(newOrchestrator().plan(pool('{ a = "1" }'))).rejects.toThrow('members is a map, where pool takes a set');
  });
});
