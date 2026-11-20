import { State } from '@clay/core';
import { planFromSchema, PlannedChange, PlanRequest, Provider, Schema, types } from '@clay/provider';
import { LocalProvider } from '@clay/provider-local';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { orchestratorIn, placeOf } from '../helpers';

const THING: Schema = { label: { type: types.string, required: true } };
const CONFIG: Schema = { region: { type: types.string, required: true } };

/** Notes each call with the region of the instance it went to. */
class Regional implements Provider {
  readonly name = 'cfg';
  readonly resources = ['cfg_thing'];
  readonly dataSources = ['cfg_data'];
  readonly importable = ['cfg_thing'];
  private region = '';

  constructor(private readonly calls: string[]) {}

  async getConfigSchema(): Promise<Schema> {
    return CONFIG;
  }

  // Slow in one region, so a block that did not wait for that instance would ask it before it is configured.
  async configure(config: Record<string, unknown>): Promise<void> {
    if (config.region === 'us') await setTimeout(50);
    this.region = String(config.region);
  }

  async getSchema(): Promise<Schema> {
    return THING;
  }

  async validate(): Promise<void> {}

  async plan(_type: string, request: PlanRequest): Promise<PlannedChange> {
    return planFromSchema(THING, request);
  }

  async read(_type: string, prior: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    this.calls.push(`read ${String(prior.label)} in ${this.region}`);
    return prior;
  }

  async create(_type: string, { config }: { config: Record<string, unknown> }): Promise<Record<string, unknown>> {
    this.calls.push(`create ${String(config.label)} in ${this.region}`);
    return config;
  }

  async update(_type: string, { config }: { config: Record<string, unknown> }): Promise<Record<string, unknown>> {
    return config;
  }

  async delete(_type: string, attributes: Record<string, unknown>): Promise<void> {
    this.calls.push(`delete ${String(attributes.label)} in ${this.region}`);
  }

  async importResource(_type: string, id: string): Promise<Record<string, unknown> | null> {
    this.calls.push(`import ${id} in ${this.region}`);
    return { label: id };
  }

  async getDataSourceSchema(): Promise<Schema> {
    return THING;
  }

  async validateDataSource(): Promise<void> {}

  async readDataSource(_type: string, inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.calls.push(`read data ${String(inputs.label)} in ${this.region}`);
    return inputs;
  }
}

const BLOCKS = 'provider "cfg" { region = "eu" }\nprovider "cfg" {\n  alias = "west"\n  region = "us"\n}\n';

const thing = (name: string, written = '') => `resource "cfg_thing" "${name}" {\n  label = "${name}"\n${written}}\n`;
const WEST = '  provider = cfg.west\n';

describe('a provider block with an alias', () => {
  let dir: string;
  let calls: string[];

  const engine = () => orchestratorIn(dir, () => new Regional(calls), new LocalProvider());

  const apply = async (config: string, destroy = false) => {
    const run = engine();
    const planned = await run.plan(config, { destroy });
    for await (const event of run.runPlan(planned, config)) if (event.type === 'failed') throw event.error;
    return planned;
  };

  const state = async () => JSON.parse(await fs.readFile(path.join(dir, 'clay.state.json'), 'utf8')) as State;

  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'clay-provider-alias-')));
    calls = [];
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('makes, refreshes and destroys each object by the instance its block names, which the state records', async () => {
    const config = BLOCKS + thing('a', WEST) + thing('b');

    await apply(config);
    expect([...calls].sort()).toEqual(['create a in us', 'create b in eu']);
    const { resources } = await state();
    expect(resources['cfg_thing.a'].alias).toBe('west');
    expect(Object.hasOwn(resources['cfg_thing.b'], 'alias')).toBe(false);

    calls.splice(0);
    await apply(config, true);
    expect([...calls].sort()).toEqual(['delete a in us', 'delete b in eu', 'read a in us', 'read b in eu']);
  });

  // With no default instance configured, a lookup that took the default would fail.
  it('needs no default instance when every block names an alias', async () => {
    const config = `provider "cfg" {\n  alias = "west"\n  region = "us"\n}\n${thing('a', WEST)}`;

    await apply(config);
    await apply(config, true);

    expect(calls).toEqual(['create a in us', 'read a in us', 'delete a in us']);
  });

  it.each([
    ['', ['read a in us', 'delete a in us', 'create a in eu']],
    ['  lifecycle { create_before_destroy = true }\n', ['read a in us', 'create a in eu', 'delete a in us']],
  ])('replaces an object whose block now names another instance, and the old one goes by the instance that made it %s', async (lifecycle, expected) => {
    await apply(BLOCKS + thing('a', WEST + lifecycle));
    calls.splice(0);

    const planned = await apply(BLOCKS + thing('a', lifecycle));

    expect(planned.actions).toMatchObject([{ type: 'REPLACE', forcedBy: ['provider'] }]);
    expect(calls).toEqual(expected);
    const { resources, deposed } = await state();
    expect(Object.hasOwn(resources['cfg_thing.a'], 'alias')).toBe(false);
    expect(deposed).toBeUndefined();
  });

  it.each([
    ['', ['read a in us', 'delete a in us', 'create b in eu']],
    ['  lifecycle { create_before_destroy = true }\n', ['read a in us', 'create b in eu', 'delete a in us']],
  ])('replaces an object moved to a block that names another instance, by the instance that made it %s', async (lifecycle, expected) => {
    await apply(BLOCKS + thing('a', WEST + lifecycle));
    calls.splice(0);

    await apply(`${BLOCKS}moved {\n  from = cfg_thing.a\n  to = cfg_thing.b\n}\n${thing('b', lifecycle)}`);

    expect(calls).toEqual(expected);
  });

  it('refuses a plan when the block of the instance that made an object is gone, naming both', async () => {
    await apply(BLOCKS + thing('a', WEST));

    await expect(engine().plan('provider "cfg" { region = "eu" }\n')).rejects.toThrow(
      'cfg_thing.a: provider "cfg" alias "west" made it, but the configuration declares no such block, so nothing can refresh or destroy it'
    );
  });

  it('reads a data source by the instance its block names', async () => {
    await engine().plan(`${BLOCKS}data "cfg_data" "d" {\n  provider = cfg.west\n  label = "d"\n}\n`);

    expect(calls).toEqual(['read data d in us']);
  });

  it('imports by the instance the target block names, and records it', async () => {
    await apply(`${BLOCKS}import {\n  to = cfg_thing.a\n  id = "a"\n}\n${thing('a', WEST)}`);

    expect(calls).toEqual(['import a in us', 'read a in us']);
    const { resources } = await state();
    expect(resources['cfg_thing.a'].alias).toBe('west');
  });

  it.each([
    ['resource', 'cfg_thing', thing('a', '  provider = local\n')],
    ['data source', 'cfg_data', 'data "cfg_data" "d" {\n  label = "d"\n  provider = local\n}\n'],
  ])('refuses a provider that does not handle the type of a %s, where it is written', async (_kind, type, block) => {
    const config = BLOCKS + block;

    const error = await engine()
      .plan(config)
      .catch((error_: unknown) => error_);

    expect(error).toMatchObject({ message: `provider "local" does not handle "${type}"; provider "cfg" does`, position: placeOf(config, 'local\n') });
  });

  it.each([
    ['resource', 'resource "cfg_thing" "a"', thing('a', '  provider = cfg.east\n')],
    ['data source', 'data "cfg_data" "d"', 'data "cfg_data" "d" {\n  label = "d"\n  provider = cfg.east\n}\n'],
  ])('refuses an alias no block declares on a %s, where it is written', async (_kind, declaration, block) => {
    const config = BLOCKS + block;

    const error = await engine()
      .plan(config)
      .catch((error_: unknown) => error_);

    expect(error).toMatchObject({ message: `${declaration} names provider "cfg" alias "east", which this module does not declare`, position: placeOf(config, 'cfg.east') });
  });

  // A destroy reads only the state and the provider blocks, so a resource block it never reads cannot stop it.
  it('destroys though a resource block names an alias no block declares', async () => {
    await apply(BLOCKS + thing('a', WEST));

    calls.splice(0);
    await apply(BLOCKS + thing('a', '  provider = cfg.east\n'), true);
    expect(calls).toEqual(['read a in us', 'delete a in us']);
  });

  it('refuses an alias in a module, though the root declares it, where it is written', async () => {
    const child = thing('a', WEST);
    await fs.mkdir(path.join(dir, 'child'));
    await fs.writeFile(path.join(dir, 'child', 'main.clay'), child);

    const error = await engine()
      .plan(`${BLOCKS}module "m" {\n  source = "./child"\n}\n`)
      .catch((error_: unknown) => error_);

    expect(error).toMatchObject({
      message: 'resource "cfg_thing" "a" names provider "cfg" alias "west", which this module does not declare',
      position: { file: 'child/main.clay', ...placeOf(child, 'cfg.west') },
    });
  });
});
