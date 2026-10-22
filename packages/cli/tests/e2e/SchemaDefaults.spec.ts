import { planFromSchema, PlannedChange, PlanRequest, Provider, Schema, types } from '@clay/contracts';
import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { start } from './start';

const SCHEMAS: Record<string, Schema> = {
  lamp: { bright: { type: types.bool, default: false } },
  vault: { pin: { type: types.string, sensitive: true, default: '0000' } },
};

/** Plans its default other than its schema gives it. */
class Wayward implements Provider {
  readonly resources = ['lamp', 'vault'];
  readonly dataSources: string[] = [];

  async getSchema(type: string): Promise<Schema> {
    return SCHEMAS[type];
  }

  async plan(type: string, request: PlanRequest): Promise<PlannedChange> {
    const { after, replace } = planFromSchema(SCHEMAS[type], request);
    return { after: { ...after, ...(type === 'lamp' ? { bright: true } : { pin: 'hunter2' }) }, replace };
  }

  async validate(): Promise<void> {}

  async read(_type: string, prior: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    return prior;
  }

  async create(): Promise<Record<string, unknown>> {
    return {};
  }

  async update(): Promise<Record<string, unknown>> {
    return {};
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

describe('a value left out that the schema gives a default', () => {
  let dir: string;

  const newOrchestrator = () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    engine.registerProvider(new Wayward());
    return engine;
  };

  const apply = async (config: string) => {
    for await (const event of start(newOrchestrator(), config)) if (event.type === 'failed') throw event.error;
  };

  const actionsOf = async (config: string) => {
    const plan = await newOrchestrator().plan(config);
    return plan.actions.map((action) => action.type);
  };

  const result = async () => {
    const state = await new LocalBackend(dir).read();
    return state.resources['random_string.r'].attributes.result;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-schema-defaults-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('is known at plan as the default', async () => {
    const plan = await newOrchestrator().plan('resource "random_string" "r" { length = 8 }');

    expect(plan.actions[0].after).toMatchObject({ special: false });
  });

  it('plans nothing when the default is written out', async () => {
    await apply('resource "random_string" "r" { length = 8 }');
    const before = await result();

    expect(await actionsOf('resource "random_string" "r" {\n  length = 8\n  special = false\n}')).toEqual(['NO_OP']);
    await apply('resource "random_string" "r" {\n  length = 8\n  special = false\n}');
    expect(await result()).toBe(before);
  });

  it('plans nothing when a value that is the default is taken out', async () => {
    await apply('resource "random_string" "r" {\n  length = 8\n  special = false\n}');

    expect(await actionsOf('resource "random_string" "r" { length = 8 }')).toEqual(['NO_OP']);
  });

  it('refuses a plan that holds another value than the default', async () => {
    await expect(newOrchestrator().plan('resource "lamp" "l" {}')).rejects.toThrow('lamp planned bright = true, but its default is false');
  });

  it('names a sensitive attribute planned other than its default, and quotes neither value', async () => {
    const plan = newOrchestrator().plan('resource "vault" "v" {}');

    await expect(plan).rejects.toThrow('vault planned pin: inconsistent values for sensitive attribute');
    await expect(plan).rejects.not.toThrow(/hunter2|0000/);
  });

  it('goes back to the default when another value is taken out', async () => {
    await apply('resource "random_string" "r" {\n  length = 8\n  special = true\n}');

    const plan = await newOrchestrator().plan('resource "random_string" "r" { length = 8 }');
    expect(plan.actions.map((action) => [action.type, action.after?.special])).toEqual([['REPLACE', false]]);
  });
});
