import { isUnknown, PlannedChange, PlanRequest, Provider, Schema, types } from '@clay/contracts';
import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { start } from './start';

const command = (text: string) => `resource "command_exec" "c" { command = "echo ${text}" }`;

/** Plans a normalized path, unlike what the configuration sets. */
class TidyProvider implements Provider {
  readonly resources = ['tidy'];
  readonly dataSources: string[] = [];

  async getSchema(): Promise<Schema> {
    return { path: { type: types.string, required: true } };
  }

  async plan(_type: string, request: PlanRequest): Promise<PlannedChange> {
    return { after: { path: String(request.config.path).trim() }, replace: [] };
  }

  async validate(): Promise<void> {}

  async read(): Promise<Record<string, unknown> | null> {
    return null;
  }

  async create(): Promise<{ id: string; attributes: Record<string, unknown> }> {
    return { id: 'tidy', attributes: {} };
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

describe('a plan the provider takes part in', () => {
  let dir: string;

  const newOrchestrator = () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    engine.registerProvider(new TidyProvider());
    return engine;
  };

  const apply = async (config: string) => {
    for await (const event of start(newOrchestrator(), config)) if (event.type === 'failed') throw event.error;
  };

  const files = (content: string) => `
    resource "local_file" "a" {
      path = "${path.join(dir, 'a.txt')}"
      content = "${content}"
    }
    resource "local_file" "b" {
      path = "${path.join(dir, 'b.txt')}"
      content = local_file.a.id
    }
  `;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-provider-plan-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('knows the id of a resource changed in place, so what reads it does not change', async () => {
    await apply(files('one'));

    const { actions } = await newOrchestrator().plan(files('two'));

    expect(actions.map(({ name, type }) => [name, type])).toEqual([
      ['a', 'UPDATE'],
      ['b', 'NO_OP'],
    ]);
  });

  it('keeps the id of a local resource with its values', async () => {
    await apply(files('one'));

    const state = await new LocalBackend(dir).read();
    expect(state.resources['local_file.a'].attributes).toEqual({ id: path.join(dir, 'a.txt'), path: path.join(dir, 'a.txt'), content: 'one' });
  });

  it('plans what a changed command prints as known after apply, and the apply reads it', async () => {
    await apply(command('one'));

    const { actions } = await newOrchestrator().plan(command('two'));
    await apply(command('two'));

    expect(actions[0].changes!.stdout.old).toBe('one\n');
    expect(isUnknown(actions[0].changes!.stdout.new)).toBe(true);
    const state = await new LocalBackend(dir).read();
    expect(state.resources['command_exec.c'].attributes.stdout).toBe('two\n');
  });

  it('refuses a plan that changes a value the configuration sets, at the resource', async () => {
    await expect(newOrchestrator().plan('\nresource "tidy" "a" { path = " x " }')).rejects.toMatchObject({
      message: 'tidy planned path = "x", but the configuration sets " x "',
      position: { file: 'main.clay', line: 2, column: 1 },
    });
  });
});
