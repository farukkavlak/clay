import { CreateRequest, planFromSchema, PlannedChange, PlanRequest, Provider, Schema, types, UpdateRequest } from '@clay/contracts';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InMemoryFiles, Orchestrator } from '../src/index';
import { apply } from './apply';

/** A thing named by `place`, which a change of `label` replaces. */
class PlacedProvider implements Provider {
  readonly resources = ['placed'];
  readonly dataSources: string[] = [];

  async getSchema(): Promise<Schema> {
    return {
      id: { type: types.string, computed: true, kept: true },
      place: { type: types.string, required: true },
      label: { type: types.string, required: true, forceNew: true },
    };
  }

  async plan(type: string, request: PlanRequest): Promise<PlannedChange> {
    return planFromSchema(await this.getSchema(), request);
  }

  async validate(): Promise<void> {}

  async read(_type: string, prior: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    return prior;
  }

  async create(_type: string, { config }: CreateRequest): Promise<Record<string, unknown>> {
    return { ...config, id: String(config.label) };
  }

  async update(_type: string, { prior, config }: UpdateRequest): Promise<Record<string, unknown>> {
    return { ...config, id: prior.id };
  }

  async delete(): Promise<void> {}

  async identify(_type: string, values: Record<string, unknown>): Promise<string | undefined> {
    return typeof values.place === 'string' ? `the place ${values.place}` : undefined;
  }

  async getDataSourceSchema(): Promise<Schema> {
    return {};
  }

  async validateDataSource(): Promise<void> {}

  async readDataSource(): Promise<Record<string, unknown>> {
    return {};
  }
}

const placed = (label: string, cbd: boolean) =>
  `resource "placed" "a" {\n  place = "p"\n  label = "${label}"\n${cbd ? '  lifecycle {\n    create_before_destroy = true\n  }\n' : ''}}\n`;

describe('a replace whose new object is its old one', () => {
  let dir: string;
  let orchestrator: Orchestrator;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'same-object-'));
    orchestrator = Orchestrator.create(new StateManager(new LocalBackend(dir)), new InMemoryFiles({}));
    orchestrator.registerProvider(new PlacedProvider());
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('is refused with create_before_destroy, whose destroy would remove the new one', async () => {
    await apply(orchestrator, placed('one', true));

    await expect(orchestrator.plan(placed('two', true))).rejects.toThrow('placed.a makes its new object before it destroys the old one, but both are the place p');
  });

  it('is planned without it, since the old one goes first', async () => {
    await apply(orchestrator, placed('one', false));

    const { actions } = await orchestrator.plan(placed('two', false));

    expect(actions.map((action) => action.type)).toEqual(['REPLACE']);
  });

  it('refuses at apply an update onto what another object is, where only the apply knows it', async () => {
    const before = 'resource "placed" "a" {\n  place = "one"\n  label = "a1"\n}\nresource "placed" "b" {\n  place = "x"\n  label = "b1"\n}\n';
    await apply(orchestrator, before);
    const after = before.replace('place = "x"', 'place = placed.c.id') + 'resource "placed" "c" {\n  place = "c"\n  label = "one"\n}\n';

    await expect(apply(orchestrator, after)).rejects.toThrow('placed.b and placed.a are both the place one');
  });
});
