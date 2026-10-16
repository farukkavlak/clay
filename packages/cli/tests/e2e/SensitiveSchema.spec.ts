import { CreateRequest, planFromSchema, PlannedChange, PlanRequest, Provider, Schema, State, types } from '@clay/contracts';
import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { start } from './start';

const SCHEMA: Schema = {
  name: { type: types.string, required: true },
  note: { type: types.string, optional: true },
  secret: { type: types.string, optional: true, sensitive: true },
  token: { type: types.string, computed: true, sensitive: true },
};

/** Makes `token` itself; the schema says it is sensitive. */
class Vault implements Provider {
  readonly resources = ['vault'];
  readonly dataSources = ['vault_lookup'];

  async getSchema(): Promise<Schema> {
    return SCHEMA;
  }

  async plan(_type: string, request: PlanRequest): Promise<PlannedChange> {
    return planFromSchema(SCHEMA, request);
  }

  async validate(_type: string, _inputs: Record<string, unknown>): Promise<void> {}

  async read(_type: string, prior: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    return prior;
  }

  async create(_type: string, { config }: CreateRequest): Promise<Record<string, unknown>> {
    return { ...config, token: `token of ${String(config.name)}` };
  }

  async update(_type: string, { config }: CreateRequest): Promise<Record<string, unknown>> {
    return { ...config, token: `token of ${String(config.name)}` };
  }

  async delete(): Promise<void> {}

  async getDataSourceSchema(): Promise<Schema> {
    return {
      path: { type: types.string, required: true },
      key: { type: types.string, optional: true, sensitive: true },
      found: { type: types.string, computed: true, sensitive: true },
      kind: { type: types.string, computed: true },
    };
  }

  async validateDataSource(_type: string, _inputs: Record<string, unknown>): Promise<void> {}

  async readDataSource(_type: string, config: Record<string, unknown>): Promise<Record<string, unknown>> {
    return { ...config, found: 'hunter2', kind: 'plain' };
  }
}

/** Refuses a resource given a secret and every data source, with a message that quotes the configuration. */
class Quoting extends Vault {
  override async validate(_type: string, inputs: Record<string, unknown>): Promise<void> {
    if (inputs.secret === undefined) return;

    throw new Error(`refused ${JSON.stringify(inputs)}`);
  }

  override async validateDataSource(_type: string, inputs: Record<string, unknown>): Promise<void> {
    throw new Error(`refused ${JSON.stringify(inputs)}`);
  }
}

const REFUSED = (name: string) => `output "${name}" holds a sensitive value; write sensitive = true to export it`;

describe('an attribute a provider marks sensitive', () => {
  let dir: string;

  const newOrchestrator = (vault: Provider = new Vault()) => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    engine.registerProvider(vault);
    return engine;
  };

  const apply = async (config: string) => {
    for await (const event of start(newOrchestrator(), config)) if (event.type === 'failed') throw event.error;
  };

  const held = async (address: string) => {
    const state = JSON.parse(await fs.readFile(path.join(dir, 'clay.state.json'), 'utf8')) as State;

    return state.resources[address];
  };

  const marksOf = async (address: string) => {
    const { sensitive } = await held(address);

    return sensitive;
  };

  const probed = async (config: string) => {
    const { outputs } = await newOrchestrator().plan(config);

    return outputs.probe.new;
  };

  const copy = () => `resource "local_file" "copy" {\n  path = "${path.join(dir, 'copy.txt')}"\n  content = vault.a.token\n}`;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-sensitive-schema-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it.each([
    ['one the provider computes', 'vault.a.token'],
    ['one the configuration gives', 'vault.a.secret'],
  ])('is refused in a root output that does not say so, where it is %s', async (_, value) => {
    const config = `resource "vault" "a" {\n  name = "x"\n  secret = "s"\n}\noutput "probe" { value = ${value} }`;

    await expect(newOrchestrator().plan(config)).rejects.toThrow(REFUSED('probe'));
    await expect(newOrchestrator().validate(config)).rejects.toThrow(REFUSED('probe'));
  });

  it('is exported by a root output that says so', async () => {
    const config = 'resource "vault" "a" { name = "x" }\noutput "probe" {\n  value = vault.a.token\n  sensitive = true\n}';

    expect(await probed(config)).toMatchObject({ sensitive: true });
  });

  it('leaves an attribute the schema does not mark in plain', async () => {
    const config = 'resource "vault" "a" {\n  name = "x"\n  note = "seen"\n}\noutput "probe" { value = vault.a.note }';

    expect(await probed(config)).toMatchObject({ value: 'seen' });
  });

  it('keeps in the state the attributes the schema marks, whether the configuration gives them or not', async () => {
    await apply('resource "vault" "a" {\n  name = "x"\n  secret = "s"\n}\nresource "vault" "b" { name = "y" }\nresource "null_resource" "n" {}');

    expect(await marksOf('vault.a')).toEqual([['secret'], ['token']]);
    expect(await marksOf('vault.b')).toEqual([['secret'], ['token']]);
    expect(await held('null_resource.n')).not.toHaveProperty('sensitive');
  });

  it('is sensitive in a resource that reads it, in the plan and in the state', async () => {
    const config = `resource "vault" "a" { name = "x" }\n${copy()}`;

    const plan = await newOrchestrator().plan(config);
    await apply(config);

    expect(plan.actions.find((action) => action.resourceType === 'local_file')?.sensitive).toEqual([['content']]);
    expect(await marksOf('local_file.copy')).toEqual([['content']]);
  });

  it('plans no change once it is applied', async () => {
    const config = `resource "vault" "a" { name = "x" }\n${copy()}`;
    await apply(config);

    const plan = await newOrchestrator().plan(config);

    expect(plan.actions.map((action) => [action.type, action.marksChange])).toEqual([
      ['NO_OP', undefined],
      ['NO_OP', undefined],
    ]);
  });

  it('keeps the mark through an update that changes the attribute', async () => {
    await apply('resource "vault" "a" { name = "x" }');
    await apply('resource "vault" "a" { name = "y" }');

    expect(await marksOf('vault.a')).toEqual([['secret'], ['token']]);
  });

  it('marks a data source attribute the schema marks', async () => {
    const config = 'data "vault_lookup" "x" { path = "p" }\noutput "probe" { value = data.vault_lookup.x.found }';

    await expect(newOrchestrator().plan(config)).rejects.toThrow(REFUSED('probe'));
    const plan = await newOrchestrator().plan('data "vault_lookup" "x" { path = "p" }');
    expect(plan.dataSensitive).toEqual({ 'data.vault_lookup.x': [['key'], ['found']] });
  });

  it('marks a data source attribute while the data source waits for the apply', async () => {
    const config = 'resource "vault" "a" { name = "x" }\ndata "vault_lookup" "x" { path = vault.a.name }\noutput "probe" { value = data.vault_lookup.x.found }';

    await expect(newOrchestrator().plan(config)).rejects.toThrow(REFUSED('probe'));
    expect(await probed(config.replace('{ value =', '{ sensitive = true\n value ='))).toMatchObject({ sensitive: true });
  });

  it.each([
    ['a resource', 'resource "vault" "a" {\n  name = "x"\n  secret = "s3cret"\n}'],
    ['a data source', 'data "vault_lookup" "x" {\n  path = "p"\n  key = "s3cret"\n}'],
    ['a data source that waits for the apply', 'resource "vault" "a" { name = "x" }\ndata "vault_lookup" "x" {\n  path = vault.a.name\n  key = "s3cret"\n}'],
  ])('hides what its provider says about %s that was given one', async (_, config) => {
    const error = await newOrchestrator(new Quoting())
      .plan(config)
      .catch((error_: Error) => error_);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('a value given to it is sensitive, so the reason is not shown');
    expect((error as Error).message).not.toContain('s3cret');
  });

  it('leaves a data source attribute the schema does not mark in plain', async () => {
    const config = 'data "vault_lookup" "x" { path = "p" }\noutput "probe" { value = data.vault_lookup.x.kind }';

    expect(await probed(config)).toMatchObject({ value: 'plain' });
  });
});
