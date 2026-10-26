import { CreateRequest, planFromSchema, PlannedChange, PlanRequest, Provider, Schema, State, STATE_VERSION, types } from '@clay/contracts';
import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { start } from '../start';

const SCHEMA: Schema = { name: { type: types.string, required: true } };

const pause = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** Takes a moment to destroy and notes when each destroy starts and ends. */
class Noting implements Provider {
  readonly resources = ['rec'];
  readonly dataSources = [];
  readonly seen: string[] = [];

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
    return { ...config };
  }

  async update(_type: string, { config }: CreateRequest): Promise<Record<string, unknown>> {
    return { ...config };
  }

  async delete(_type: string, prior: Record<string, unknown>): Promise<void> {
    const name = String(prior.name);
    this.seen.push(`start ${name}`);
    await pause(30);
    this.seen.push(`end ${name}`);
  }

  async getDataSourceSchema(): Promise<Schema> {
    return {};
  }

  async validateDataSource(): Promise<void> {}

  async readDataSource(): Promise<Record<string, unknown>> {
    return {};
  }
}

describe('destroying a deposed object', () => {
  let dir: string;
  let provider: Noting;
  let engine: Orchestrator;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-deposed-order-'));
    provider = new Noting();
    engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(provider);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('waits for a resource that depends on its resource to be destroyed first', async () => {
    const state: State = {
      version: STATE_VERSION,
      serial: 0,
      resources: { 'rec.b': { resourceType: 'rec', name: 'b', attributes: { name: 'b' }, dependencies: ['rec.a'] } },
      deposed: { 'rec.a': [{ attributes: { name: 'a-old' } }] },
    };
    await new LocalBackend(dir).write(state);

    for await (const event of start(engine, '')) if (event.type === 'failed') throw event.error;

    expect(provider.seen).toEqual(['start b', 'end b', 'start a-old', 'end a-old']);
  });

  it('is destroyed before a resource its stored dependencies name, and before a deposed object of one', async () => {
    const state: State = {
      version: STATE_VERSION,
      serial: 0,
      resources: { 'rec.b': { resourceType: 'rec', name: 'b', attributes: { name: 'b' } } },
      deposed: {
        'rec.a': [{ attributes: { name: 'a-old' }, dependencies: ['rec.b', 'rec.c'] }],
        'rec.c': [{ attributes: { name: 'c-old' } }],
      },
    };
    await new LocalBackend(dir).write(state);

    for await (const event of start(engine, '')) if (event.type === 'failed') throw event.error;

    expect(provider.seen.indexOf('end a-old')).toBeLessThan(provider.seen.indexOf('start b'));
    expect(provider.seen.indexOf('end a-old')).toBeLessThan(provider.seen.indexOf('start c-old'));
  });

  it('still destroys all of them where objects left at different times name each other', async () => {
    const state: State = {
      version: STATE_VERSION,
      serial: 0,
      resources: { 'rec.a': { resourceType: 'rec', name: 'a', attributes: { name: 'a' }, dependencies: ['rec.b'] } },
      deposed: { 'rec.b': [{ attributes: { name: 'b-old' }, dependencies: ['rec.a'] }] },
    };
    await new LocalBackend(dir).write(state);

    for await (const event of start(engine, '')) if (event.type === 'failed') throw event.error;

    expect([...provider.seen].filter((note) => note.startsWith('end')).sort()).toEqual(['end a', 'end b-old']);
  });

  it('is destroyed after a resource that depends on what it was left by, whichever the state lists first', async () => {
    const state: State = {
      version: STATE_VERSION,
      serial: 0,
      resources: {
        'rec.a': { resourceType: 'rec', name: 'a', attributes: { name: 'a' } },
        'rec.b': { resourceType: 'rec', name: 'b', attributes: { name: 'b' }, dependencies: ['rec.a'] },
      },
      deposed: { 'rec.a': [{ attributes: { name: 'a-old' }, dependencies: [] }] },
    };
    await new LocalBackend(dir).write(state);

    for await (const event of start(engine, '')) if (event.type === 'failed') throw event.error;

    expect(provider.seen.indexOf('start b')).toBeLessThan(provider.seen.indexOf('start a'));
    expect(provider.seen.indexOf('end b')).toBeLessThan(provider.seen.indexOf('start a-old'));
  });
});
