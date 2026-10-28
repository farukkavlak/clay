import { CreateRequest, planFromSchema, PlannedChange, PlanRequest, Provider, Schema, types } from '@clay/contracts';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RunEvent } from '../src/index';
import { engineOn, TestEngine } from './engine';

const SCHEMA: Schema = { id: { type: types.string, computed: true, kept: true }, name: { type: types.string } };
const DATA_SCHEMA: Schema = { id: { type: types.string, computed: true }, name: { type: types.string } };

/** Aborts the run while it creates or deletes a resource, so that one finishes and nothing after it starts. */
class Interrupting implements Provider {
  readonly resources = ['mock_resource'];
  readonly dataSources = ['mock_data'];
  readonly created: string[] = [];
  readonly reads: string[] = [];
  readonly deleted: string[] = [];
  /** Left out for a run that sets up the state. */
  aborting?: AbortController;

  async getSchema(): Promise<Schema> {
    return SCHEMA;
  }

  async plan(_type: string, request: PlanRequest): Promise<PlannedChange> {
    return planFromSchema(SCHEMA, request);
  }

  async validate(): Promise<void> {}

  async create(_type: string, { config }: CreateRequest): Promise<Record<string, unknown>> {
    this.aborting?.abort();
    this.created.push(String(config.name));
    return { ...config, id: `id-${String(config.name)}` };
  }

  async update(): Promise<Record<string, unknown>> {
    throw new Error('not planned');
  }

  async delete(_type: string, prior: Record<string, unknown>): Promise<void> {
    this.aborting?.abort();
    this.deleted.push(String(prior.name));
  }

  async getDataSourceSchema(): Promise<Schema> {
    return DATA_SCHEMA;
  }

  async validateDataSource(): Promise<void> {}

  async read(_type: string, prior: Record<string, unknown>): Promise<Record<string, unknown>> {
    return prior;
  }

  async readDataSource(_type: string, inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.reads.push(String(inputs.name));
    return { ...inputs, id: 'data' };
  }
}

describe('a run whose signal aborts', () => {
  let dir: string;
  let engine: TestEngine;
  let provider: Interrupting;
  let controller: AbortController;

  const run = async (config: string): Promise<RunEvent['type'][]> => {
    const events: RunEvent['type'][] = [];
    for await (const event of engine.runPlan(await engine.plan(config), config, { parallelism: 1, signal: controller.signal })) events.push(event.type);
    return events;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-abort-'));
    controller = new AbortController();
    provider = new Interrupting();
    provider.aborting = controller;
    engine = engineOn(new StateManager(new LocalBackend(dir)));
    engine.registerProvider(provider);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('starts no action that waits for room, and ends without done', async () => {
    const events = await run('resource "mock_resource" "a" { name = "a" }\nresource "mock_resource" "b" { name = "b" }');

    expect(provider.created).toHaveLength(1);
    expect(events).toEqual(['planned', 'started', 'applied']);
  });

  it('reads no data source that waits for a resource', async () => {
    await run('resource "mock_resource" "a" { name = "a" }\ndata "mock_data" "d" { name = mock_resource.a.id }');

    expect(provider.created).toEqual(['a']);
    expect(provider.reads).toEqual([]);
  });

  it('saves what finished', async () => {
    await run('resource "mock_resource" "a" { name = "a" }\nresource "mock_resource" "b" { name = "b" }');

    const state = JSON.parse(await fs.readFile(path.join(dir, 'clay.state.json'), 'utf8')) as { resources: Record<string, unknown> };
    expect(Object.keys(state.resources)).toEqual([`mock_resource.${provider.created[0]}`]);
  });

  // `reader` reads `read`, so `read` is deleted only after it.
  it('deletes nothing once it aborts', async () => {
    provider.aborting = undefined;
    await run('resource "mock_resource" "read" { name = "read" }\nresource "mock_resource" "reader" { name = "${mock_resource.read.name}er" }');
    provider.aborting = controller;

    await run('');

    expect(provider.deleted).toEqual(['reader']);
    const state = JSON.parse(await fs.readFile(path.join(dir, 'clay.state.json'), 'utf8')) as { resources: Record<string, unknown> };
    expect(Object.keys(state.resources)).toEqual(['mock_resource.read']);
  });

  it('finishes a run whose last action it waited for, when only outputs are left', async () => {
    const events = await run('resource "mock_resource" "a" { name = "a" }\noutput "id" { value = mock_resource.a.id }');

    expect(events).toEqual(['planned', 'started', 'applied', 'done']);
  });
});
