import { planFromSchema, PlannedChange, PlanRequest, Provider, Schema, UNKNOWN } from '@clay/contracts';
import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { start } from './start';

/** Plans a label as the configuration sets it, then makes it upper case and adds a value it never planned. */
class LoudProvider implements Provider {
  readonly resources = ['loud'];
  readonly dataSources: string[] = [];

  async getSchema(): Promise<Schema> {
    return { label: { type: 'string', required: true } };
  }

  async plan(_type: string, request: PlanRequest): Promise<PlannedChange> {
    return planFromSchema(await this.getSchema(), request);
  }

  async validate(): Promise<void> {}

  async read(_type: string, _id: string, prior: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    return prior;
  }

  async create(_type: string, inputs: Record<string, unknown>): Promise<{ id: string; attributes: Record<string, unknown> }> {
    return { id: 'loud-id', attributes: { label: String(inputs.label).toUpperCase(), volume: 'high' } };
  }

  async update(): Promise<Record<string, unknown>> {
    return {};
  }

  async delete(): Promise<void> {}

  async validateDataSource(): Promise<void> {}

  async readDataSource(): Promise<Record<string, unknown>> {
    return {};
  }
}

/** Makes what it is told to and reads back what it was given, with `extra` added to it. */
class EchoProvider extends LoudProvider {
  override readonly resources = ['echo'];

  constructor(private extra: Record<string, unknown> = {}) {
    super();
  }

  override async create(_type: string, inputs: Record<string, unknown>): Promise<{ id: string; attributes: Record<string, unknown> }> {
    return { id: 'echo-id', attributes: inputs };
  }

  override async read(_type: string, _id: string, prior: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    return { ...prior, ...this.extra };
  }
}

/** Reads a data source with a value it says is not known. */
class VagueReader extends LoudProvider {
  override readonly resources: string[] = [];
  override readonly dataSources = ['vague'];

  override async readDataSource(): Promise<Record<string, unknown>> {
    return { content: UNKNOWN };
  }
}

describe('what an apply returns, held to the plan', () => {
  let dir: string;
  let file: string;

  const config = () => `
    resource "loud" "a" { label = "quiet" }
    resource "local_file" "copy" {
      path = "${file}"
      content = loud.a.label
    }
  `;

  const newOrchestrator = () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    engine.registerProvider(new LoudProvider());
    return engine;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-apply-result-'));
    file = path.join(dir, 'copy.txt');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('stops the run at a resource its provider made otherwise than planned, and keeps what it made in state', async () => {
    const failures: Error[] = [];
    for await (const event of start(newOrchestrator(), config())) if (event.type === 'failed') failures.push(event.error);

    expect(failures.map(({ message }) => message)).toEqual([
      'loud returned what the plan did not show, which is a bug in the provider:\n  label = "QUIET", where the plan showed "quiet"\n  volume = "high", which the plan did not have',
    ]);
    const state = await new LocalBackend(dir).read();
    expect(state.resources['loud.a']).toMatchObject({ id: 'loud-id', attributes: { label: 'QUIET', volume: 'high' } });
    expect(Object.keys(state.resources)).toEqual(['loud.a']);
    await expect(fs.access(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('what a refresh reads, held to what a resource can hold', () => {
  let dir: string;

  const newOrchestrator = (echo: EchoProvider) => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(echo);
    return engine;
  };

  const apply = async (config: string) => {
    for await (const event of start(newOrchestrator(new EchoProvider()), config)) if (event.type === 'failed') throw event.error;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-read-result-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it.each([
    ['a name the provider made up', { volume: 'high' }, 'volume = "high", which neither the schema nor the resource has'],
    ['a value not known', { label: UNKNOWN }, 'label is not known; a read returns every value'],
  ])('refuses %s, at the resource', async (_, extra, line) => {
    const config = 'resource "echo" "a" { label = "a" }';
    await apply(config);

    await expect(newOrchestrator(new EchoProvider(extra)).plan(config)).rejects.toThrow(
      `echo.a: echo read what the resource cannot hold, which is a bug in the provider:\n  ${line}`
    );
  });

  it('plans nothing for a name the configuration set that the schema does not have', async () => {
    const config = 'resource "echo" "a" {\n  label = "a"\n  bogus = "1"\n}';
    await apply(config);

    const { actions } = await newOrchestrator(new EchoProvider()).plan(config);

    expect(actions.map(({ type }) => type)).toEqual(['NO_OP']);
  });
});

describe('what a data source reads', () => {
  it('refuses a value not known, at the data block', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-data-result-'));
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new VagueReader());

    try {
      await expect(engine.plan('\ndata "vague" "v" {}')).rejects.toMatchObject({
        message: 'vague read what the data source cannot hold, which is a bug in the provider:\n  content is not known; a read returns every value',
        position: { file: 'main.clay', line: 2, column: 1 },
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
