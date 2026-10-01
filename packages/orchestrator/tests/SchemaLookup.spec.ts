import { CreateRequest, planFromSchema, PlannedChange, PlanRequest, Provider, Schema, UpdateRequest } from '@clay/contracts';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InMemoryFiles, Orchestrator } from '../src/index';
import { apply } from './apply';

/** `constructor` is a name every plain object already answers to, and a provider is free to use it for a resource type. */
class InheritedNameProvider implements Provider {
  readonly resources = ['constructor'];
  readonly dataSources: string[] = [];

  async getSchema(_type: string): Promise<Schema> {
    return { path: { type: 'string', forceNew: true } };
  }

  async plan(type: string, request: PlanRequest): Promise<PlannedChange> {
    return planFromSchema(await this.getSchema(type), request);
  }

  async validate(_type: string, _inputs: Record<string, unknown>): Promise<void> {}

  async create(_type: string, { config }: CreateRequest): Promise<Record<string, unknown>> {
    return config;
  }

  async update(_type: string, { config }: UpdateRequest): Promise<Record<string, unknown>> {
    return config;
  }

  async delete(): Promise<void> {}

  async getDataSourceSchema(): Promise<Schema> {
    return {};
  }

  async validateDataSource(_type: string, _inputs: Record<string, unknown>): Promise<void> {}

  async read(_type: string, prior: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    return prior;
  }

  async readDataSource(_type: string, _inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
    return {};
  }
}

const config = (attributePath: string) => `resource "constructor" "a" { path = "${attributePath}" }`;

describe('a resource type named after something every object has', () => {
  let dir: string;
  let orchestrator: Orchestrator;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-schema-lookup-'));
    orchestrator = Orchestrator.create(new StateManager(new LocalBackend(dir)), new InMemoryFiles({}));
    orchestrator.registerProvider(new InheritedNameProvider());
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  // The schema was collected into a plain object, where the type name already held a value, so the provider's own schema was dropped.
  it('still reads the schema, so a forceNew attribute plans a REPLACE', async () => {
    await apply(orchestrator, config('old'));

    const planned = await orchestrator.plan(config('new'));

    expect(planned.actions.map((action) => action.type)).toEqual(['REPLACE']);
  });
});
