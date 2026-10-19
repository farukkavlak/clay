import { Address, CreateRequest, planFromSchema, PlannedChange, PlanRequest, Provider, Schema, State, STATE_VERSION, types, UpdateRequest } from '@clay/contracts';
import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { start } from './start';

const SCHEMA: Schema = {
  name: { type: types.string, required: true, forceNew: true },
  uses: { type: types.string, optional: true, forceNew: true },
  note: { type: types.string, optional: true },
};

/** As a cloud does: an object another one uses cannot be destroyed, and one cannot use an object that does not exist. */
class Using implements Provider {
  readonly resources = ['rec'];
  readonly dataSources = [];
  readonly seen: string[] = [];
  /** Each live object's name, and the name of the one it uses. */
  readonly live = new Map<string, string | undefined>();
  readonly failingDelete = new Set<string>();
  /** Called once each object is destroyed. */
  destroyed: (name: string) => void = () => {};

  async getSchema(): Promise<Schema> {
    return SCHEMA;
  }

  async plan(_type: string, request: PlanRequest): Promise<PlannedChange> {
    return planFromSchema(SCHEMA, request);
  }

  async validate(): Promise<void> {}

  async read(_type: string, prior: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    return prior;
  }

  async create(_type: string, { config }: CreateRequest): Promise<Record<string, unknown>> {
    const name = String(config.name);
    const uses = typeof config.uses === 'string' ? config.uses : undefined;
    if (uses !== undefined && !this.live.has(uses)) throw new Error(`${name} cannot use ${uses}, which does not exist`);

    this.live.set(name, uses);
    this.seen.push(`create ${name}`);
    return { ...config };
  }

  async update(_type: string, { config }: UpdateRequest): Promise<Record<string, unknown>> {
    this.seen.push(`update ${String(config.name)}`);
    return { ...config };
  }

  async delete(_type: string, prior: Record<string, unknown>): Promise<void> {
    const name = String(prior.name);
    if (this.failingDelete.has(name)) throw new Error(`${name} cannot be destroyed`);

    const user = [...this.live].find(([, uses]) => uses === name);
    if (user) throw new Error(`${name} cannot be destroyed while ${user[0]} uses it`);

    this.live.delete(name);
    this.seen.push(`delete ${name}`);
    this.destroyed(name);
  }

  async getDataSourceSchema(): Promise<Schema> {
    return {};
  }

  async validateDataSource(): Promise<void> {}

  async readDataSource(): Promise<Record<string, unknown>> {
    return {};
  }
}

const rec = (name: string, label: string, ...body: string[]) => `resource "rec" "${name}" {\n  name = "${label}"\n${body.map((line) => `  ${line}\n`).join('')}}\n`;

describe('replacing a resource that something reads', () => {
  let dir: string;
  let provider: Using;
  let engine: Orchestrator;

  const applied = async (config: string) => {
    for await (const event of start(engine, config)) if (event.type === 'failed') throw event.error;
  };

  const held = async () => (await new LocalBackend(dir).read()) as State;
  const heldAddresses = async () => {
    const { resources } = await held();
    return Object.keys(resources);
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-destroy-readers-'));
    provider = new Using();
    engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(provider);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('destroys the reader that is replaced too before it, and creates it after', async () => {
    await applied(rec('a', 'a1') + rec('b', 'b1', 'uses = rec.a.name'));
    provider.seen.length = 0;

    await applied(rec('a', 'a2') + rec('b', 'b2', 'uses = rec.a.name'));

    expect(provider.seen).toEqual(['delete b1', 'delete a1', 'create a2', 'create b2']);
  });

  it('destroys a reader the configuration no longer has before it', async () => {
    await applied(rec('a', 'a1') + rec('b', 'b1', 'uses = rec.a.name'));
    provider.seen.length = 0;

    await applied(rec('a', 'a2'));

    expect(provider.seen).toEqual(['delete b1', 'delete a1', 'create a2']);
    expect(await heldAddresses()).toEqual(['rec.a']);
  });

  it('destroys every reader down a chain, the last first, and creates them back in order', async () => {
    await applied(rec('a', 'a1') + rec('b', 'b1', 'uses = rec.a.name') + rec('c', 'c1', 'uses = rec.b.name'));
    provider.seen.length = 0;

    await applied(rec('a', 'a2') + rec('b', 'b2', 'uses = rec.a.name') + rec('c', 'c1', 'uses = rec.b.name'));

    expect(provider.seen).toEqual(['delete c1', 'delete b1', 'delete a1', 'create a2', 'create b2', 'create c1']);
  });

  it('destroys a deposed object that reads it before it', async () => {
    const state: State = {
      version: STATE_VERSION,
      serial: 0,
      resources: { 'rec.a': { resourceType: 'rec', name: 'a', attributes: { name: 'a1', uses: null, note: null } } },
      deposed: { 'rec.b': [{ attributes: { name: 'b-old', uses: 'a1', note: null }, dependencies: ['rec.a'] }] },
    };
    await new LocalBackend(dir).write(state);
    provider.live.set('a1', undefined);
    provider.live.set('b-old', 'a1');

    await applied(rec('a', 'a2'));

    expect(provider.seen).toEqual(['delete b-old', 'delete a1', 'create a2']);
    const { deposed } = await held();
    expect(deposed).toBeUndefined();
  });

  it('keeps an ignored value of a reader it destroyed first', async () => {
    const ignoring = ['note = "two"', 'lifecycle {\n    ignore_changes = [note]\n  }'];
    await applied(rec('a', 'a1') + rec('b', 'b1', 'uses = rec.a.name', 'note = "one"'));

    await applied(rec('a', 'a2') + rec('b', 'b1', 'uses = rec.a.name', ...ignoring));

    const { resources } = await held();
    expect(resources['rec.b'].attributes.note).toBe('one');
  });

  it('starts no other destroy once interrupted', async () => {
    await applied(rec('a', 'a1') + rec('b', 'b1', 'uses = rec.a.name') + rec('c', 'c1', 'uses = rec.b.name'));
    provider.seen.length = 0;
    const interrupt = new AbortController();
    provider.destroyed = () => interrupt.abort();
    const config = rec('a', 'a2') + rec('b', 'b2', 'uses = rec.a.name') + rec('c', 'c1', 'uses = rec.b.name');

    for await (const event of engine.runPlan(await engine.plan(config), config, { signal: interrupt.signal })) if (event.type === 'failed') throw event.error;

    expect(provider.seen).toEqual(['delete c1']);
    expect(await heldAddresses()).toEqual(['rec.a', 'rec.b']);
  });

  it('takes a deposed reader for no read of the current object at its address', async () => {
    const state: State = {
      version: STATE_VERSION,
      serial: 0,
      resources: {
        'rec.a': { resourceType: 'rec', name: 'a', attributes: { name: 'a1', uses: null, note: null } },
        'rec.b': { resourceType: 'rec', name: 'b', attributes: { name: 'b1' } },
        'rec.c': { resourceType: 'rec', name: 'c', attributes: { name: 'c1', uses: 'b1', note: null }, dependencies: ['rec.b'] },
      },
      deposed: { 'rec.b': [{ attributes: { name: 'b-old', uses: 'a1', note: null }, dependencies: ['rec.a'] }] },
    };
    await new LocalBackend(dir).write(state);
    for (const [name, uses] of [['a1'], ['b1'], ['c1', 'b1'], ['b-old', 'a1']]) provider.live.set(name, uses);

    await applied(rec('a', 'a2') + rec('b', 'b1'));

    expect(provider.seen).toEqual(['delete b-old', 'delete a1', 'create a2', 'delete c1']);
  });

  it('stops where a reader cannot be destroyed, and names the replace', async () => {
    await applied(rec('a', 'a1') + rec('b', 'b1', 'uses = rec.a.name'));
    provider.seen.length = 0;
    provider.failingDelete.add('b1');

    const failures = [];
    for await (const event of start(engine, rec('a', 'a2') + rec('b', 'b2', 'uses = rec.a.name'))) if (event.type === 'failed') failures.push(event);

    expect(failures.map((event) => [Address.of(event.action).toString(), event.action.type, event.error.message])).toEqual([['rec.b', 'REPLACE', 'b1 cannot be destroyed']]);
    expect(provider.seen).toEqual([]);
    expect(await heldAddresses()).toEqual(['rec.a', 'rec.b']);
  });

  it('leaves a reader it can still update in place, and replaces only what it reads', async () => {
    await applied(rec('a', 'a1') + rec('b', 'b1', 'note = rec.a.name'));
    provider.seen.length = 0;

    await applied(rec('a', 'a2') + rec('b', 'b1', 'note = rec.a.name'));

    expect(provider.seen).toEqual(['delete a1', 'create a2', 'update b1']);
  });
});
