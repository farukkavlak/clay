import { Address, CreateRequest, planFromSchema, PlannedChange, PlanRequest, Provider, Schema, State, STATE_VERSION, types, UpdateRequest } from '@clay/contracts';
import { DiskFiles, Orchestrator, RunEvent } from '@clay/orchestrator';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { start } from './start';

const SCHEMA: Schema = {
  name: { type: types.string, required: true, forceNew: true },
  uses: { type: types.string, optional: true, forceNew: true },
  /** Uses an object as `uses` does, but changes in place. */
  holds: { type: types.string, optional: true },
  note: { type: types.string, optional: true },
};

function used(config: Record<string, unknown>): string | undefined {
  const uses = config.uses ?? config.holds;
  return typeof uses === 'string' ? uses : undefined;
}

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
    const uses = used(config);
    if (uses !== undefined && !this.live.has(uses)) throw new Error(`${name} cannot use ${uses}, which does not exist`);

    this.live.set(name, uses);
    this.seen.push(`create ${name}`);
    return { ...config };
  }

  async update(_type: string, { config }: UpdateRequest): Promise<Record<string, unknown>> {
    this.live.set(String(config.name), used(config));
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

  it('reports a reader it destroyed first when the replace it waited for fails', async () => {
    await applied(rec('a', 'a1') + rec('b', 'b1', 'uses = rec.a.name'));

    const reported: string[][] = [];
    for await (const event of start(engine, rec('a', 'a2', 'uses = "gone"') + rec('b', 'b2', 'uses = rec.a.name')))
      if (event.type === 'destroyed' || event.type === 'failed') reported.push([event.type, Address.of(event.action).toString()]);

    expect(reported).toEqual([
      ['destroyed', 'rec.b'],
      ['destroyed', 'rec.a'],
      ['failed', 'rec.a'],
    ]);
  });

  it('reports the object a replace destroyed when its create then fails', async () => {
    await applied(rec('a', 'a1'));

    const reported: string[][] = [];
    for await (const event of start(engine, rec('a', 'a2', 'uses = "gone"')))
      if (event.type === 'destroyed' || event.type === 'failed') reported.push([event.type, Address.of(event.action).toString()]);

    expect(reported).toEqual([
      ['destroyed', 'rec.a'],
      ['failed', 'rec.a'],
    ]);
    expect(provider.seen).toEqual(['create a1', 'delete a1']);
  });

  it('reports no destroy when a replace stops before it', async () => {
    await applied(rec('a', 'a1') + rec('b', 'b1'));
    const config = rec('a', 'a2', 'uses = rec.b.name') + rec('b', 'b2');
    const plan = await engine.plan(config);
    provider.failingDelete.add('b1');

    const reported: string[][] = [];
    for await (const event of engine.runPlan(plan, config))
      if (event.type === 'destroyed' || event.type === 'failed') reported.push([event.type, Address.of(event.action).toString()]);

    expect(reported).toEqual([['failed', 'rec.b']]);
  });

  it('reports a reader it destroyed first when interrupted after it', async () => {
    await applied(rec('a', 'a1') + rec('b', 'b1', 'uses = rec.a.name'));
    const interrupt = new AbortController();
    provider.destroyed = () => interrupt.abort();
    const config = rec('a', 'a2') + rec('b', 'b2', 'uses = rec.a.name');

    const reported: RunEvent[] = [];
    for await (const event of engine.runPlan(await engine.plan(config), config, { signal: interrupt.signal })) if (event.type !== 'planned') reported.push(event);

    expect(reported.map((event) => [event.type, 'action' in event ? Address.of(event.action).toString() : ''])).toEqual([['destroyed', 'rec.b']]);
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

    expect(provider.seen).toEqual(['delete c1', 'delete b-old', 'delete a1', 'create a2']);
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

  it('destroys a create-first reader that reads it only in state before it', async () => {
    await applied(rec('a', 'a1') + rec('x', 'x1', 'uses = rec.a.name'));

    provider.seen.length = 0;

    await applied(rec('a', 'a2') + rec('x', 'x2', 'lifecycle {\n    create_before_destroy = true\n  }'));

    expect(provider.seen).toEqual(['create x2', 'delete x1', 'delete a1', 'create a2']);
  });

  it('makes a new reader of a create-first replace after the old object and what it read are gone', async () => {
    await applied(rec('a', 'a1') + rec('x', 'x1', 'uses = rec.a.name'));
    provider.seen.length = 0;

    await applied(rec('a', 'a2') + rec('x', 'x2', 'lifecycle {\n    create_before_destroy = true\n  }') + rec('r', 'r1', 'note = rec.a.name', 'holds = rec.x.name'));

    expect(provider.seen).toEqual(['create x2', 'delete x1', 'delete a1', 'create a2', 'create r1']);
  });

  it('refuses an order that waits for itself at plan, at the create-first block', async () => {
    await applied(rec('a', 'a1') + rec('x', 'x1', 'uses = rec.a.name') + rec('r', 'r1', 'note = rec.a.name', 'holds = rec.x.name'));
    provider.seen.length = 0;
    const before = await held();

    await expect(
      applied(rec('a', 'a2') + rec('x', 'x2', 'lifecycle {\n    create_before_destroy = true\n  }') + rec('r', 'r1', 'note = rec.a.name', 'holds = rec.x.name'))
    ).rejects.toMatchObject({
      message: 'No order applies this plan: rec.a waits for destroying the old rec.x, which waits for rec.r, which waits for rec.a',
      position: { line: 4 },
      block: 'resource "rec" "x"',
    });
    expect(provider.seen).toEqual([]);
    expect(await held()).toEqual(before);
  });

  it('updates what stays and used a removed resource before destroying it', async () => {
    await applied(rec('a', 'a1') + rec('b', 'b1', 'holds = rec.a.name'));
    provider.seen.length = 0;

    await applied(rec('b', 'b1'));

    expect(provider.seen).toEqual(['update b1', 'delete a1']);
  });

  it('updates what stays and used a replace only in state before the replace destroys it', async () => {
    await applied(rec('a', 'a1') + rec('b', 'b1', 'holds = rec.a.name'));
    provider.seen.length = 0;

    await applied(rec('a', 'a2') + rec('b', 'b1'));

    expect(provider.seen).toEqual(['update b1', 'delete a1', 'create a2']);
  });

  it('updates what stays and used a delete before the delete goes ahead of a replace', async () => {
    await applied(rec('a', 'a1') + rec('d', 'd1', 'uses = rec.a.name') + rec('k', 'k1', 'holds = rec.d.name'));
    provider.seen.length = 0;

    await applied(rec('a', 'a2') + rec('k', 'k1'));

    expect(provider.seen).toEqual(['update k1', 'delete d1', 'delete a1', 'create a2']);
  });

  it('updates what stays and used a replace before destroying it ahead of another replace', async () => {
    await applied(rec('a', 'a1') + rec('b', 'b1', 'uses = rec.a.name') + rec('k', 'k1', 'holds = rec.b.name'));
    provider.seen.length = 0;

    await applied(rec('a', 'a2') + rec('b', 'b2', 'uses = rec.a.name') + rec('k', 'k1'));

    expect(provider.seen).toEqual(['update k1', 'delete b1', 'delete a1', 'create a2', 'create b2']);
  });

  it('plans a create-first replace whose old object waits for what stays, where another wait gives way to it', async () => {
    const before = rec('x', 'x1') + rec('y', 'y1') + rec('b', 'b1', 'uses = rec.x.name');
    const after = rec('x', 'x2') + rec('y', 'y2') + rec('b', 'b2', 'lifecycle {\n    create_before_destroy = true\n  }');
    await applied(before + rec('k', 'k1', 'note = rec.x.name', 'holds = rec.y.name') + rec('j', 'j1', 'note = rec.y.name', 'holds = rec.b.name'));
    provider.seen.length = 0;

    const failures = [];
    for await (const event of start(engine, after + rec('k', 'k1', 'note = rec.x.name') + rec('j', 'j1', 'note = rec.y.name', 'holds = rec.b.name')))
      if (event.type === 'failed') failures.push(event);

    expect(failures.map((event) => [Address.of(event.action).toString(), event.error.message])).toEqual([['rec.y', 'y1 cannot be destroyed while k1 uses it']]);
    expect(provider.seen).toEqual(['create b2']);
  });

  it('destroys a delete ahead of a replace that what stays reads, without waiting for it to let go', async () => {
    await applied(rec('a', 'a1') + rec('d', 'd1', 'uses = rec.a.name') + rec('k', 'k1', 'note = rec.a.name', 'holds = rec.d.name'));
    provider.seen.length = 0;

    const failures = [];
    for await (const event of start(engine, rec('a', 'a2') + rec('k', 'k1', 'note = rec.a.name'))) if (event.type === 'failed') failures.push(event);

    expect(failures.map((event) => [Address.of(event.action).toString(), event.error.message])).toEqual([['rec.d', 'd1 cannot be destroyed while k1 uses it']]);
    expect(provider.seen).toEqual([]);
  });

  it('leaves a reader it can still update in place, and replaces only what it reads', async () => {
    await applied(rec('a', 'a1') + rec('b', 'b1', 'note = rec.a.name'));
    provider.seen.length = 0;

    await applied(rec('a', 'a2') + rec('b', 'b1', 'note = rec.a.name'));

    expect(provider.seen).toEqual(['delete a1', 'create a2', 'update b1']);
  });
});
