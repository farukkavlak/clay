import { planFromSchema, PlannedChange, PlanRequest, Provider, Schema, types } from '@clay/provider';
import { LocalProvider } from '@clay/provider-local';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { orchestratorIn } from '../helpers';
import { start } from '../start';

const THING: Schema = { label: { type: types.string, required: true } };
const CONFIG: Schema = { region: { type: types.string, required: true }, token: { type: types.string, sensitive: true } };

/** Notes what each instance is configured with, and refuses a token. */
class Configured implements Provider {
  readonly name = 'cfg';
  readonly resources = ['cfg_thing'];
  readonly dataSources = ['cfg_data'];

  constructor(
    private readonly log: Record<string, unknown>[],
    private readonly config: Schema = CONFIG
  ) {}

  async getConfigSchema(): Promise<Schema> {
    return this.config;
  }

  async configure(config: Record<string, unknown>): Promise<void> {
    this.log.push(config);
    if (config.token !== undefined) throw new Error(`token ${String(config.token)} expired`);
  }

  async getSchema(): Promise<Schema> {
    return THING;
  }

  async validate(): Promise<void> {}

  async plan(_type: string, request: PlanRequest): Promise<PlannedChange> {
    return planFromSchema(THING, request);
  }

  async read(_type: string, prior: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    return prior;
  }

  async create(_type: string, { config }: { config: Record<string, unknown> }): Promise<Record<string, unknown>> {
    return config;
  }

  async update(_type: string, { config }: { config: Record<string, unknown> }): Promise<Record<string, unknown>> {
    return config;
  }

  async delete(): Promise<void> {}

  async getDataSourceSchema(): Promise<Schema> {
    return THING;
  }

  async validateDataSource(): Promise<void> {}

  async readDataSource(_type: string, inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
    return inputs;
  }
}

const THING_A = 'resource "cfg_thing" "a" { label = "a" }\n';

describe('a provider block', () => {
  let dir: string;
  let log: Record<string, unknown>[];

  const engine = (config?: Schema) => orchestratorIn(dir, () => new Configured(log, config), new LocalProvider());

  const apply = async (config: string) => {
    for await (const event of start(engine(), config)) if (event.type === 'failed') throw event.error;
  };

  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'clay-provider-block-')));
    log = [];
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('configures the plan and the apply with what it sets, read from a variable, a local and a data source', async () => {
    await fs.writeFile(path.join(dir, 'zone.txt'), 'x');
    const config = `variable "r" { default = "eu" }\nlocals { zone = "a" }\ndata "local_file" "z" { path = "${path.join(dir, 'zone.txt')}" }\nprovider "cfg" {\n  region = "\${var.r}-\${local.zone}-\${data.local_file.z.content}"\n}\n${THING_A}`;

    await apply(config);

    expect(log).toEqual([{ region: 'eu-a-x' }, { region: 'eu-a-x' }]);
  });

  it('refuses a provider that requires a value when no block sets it', async () => {
    await expect(engine().plan(THING_A)).rejects.toThrow('provider "cfg" requires "region", but the configuration has no provider "cfg" block');
  });

  it('refuses an argument the provider does not take, where it is written', async () => {
    const error = await engine()
      .plan(`provider "cfg" {\n  region = "eu"\n  regoin = "eu"\n}\n${THING_A}`)
      .catch((error_: unknown) => error_);

    expect(error).toMatchObject({ message: 'provider "cfg" has no attribute "regoin"', position: { line: 3 } });
  });

  it('refuses a value of the wrong type, where it is written', async () => {
    const error = await engine()
      .plan(`provider "cfg" {\n  region = ["eu"]\n}\n${THING_A}`)
      .catch((error_: unknown) => error_);

    expect(error).toMatchObject({ position: { line: 2 } });
    expect((error as Error).message).toContain('region');
  });

  it('refuses a block for a provider there is none of', async () => {
    await expect(engine().plan('provider "nope" {}')).rejects.toThrow('No provider is named "nope"');
  });

  it.each([
    ['a resource', 'region = cfg_thing.a.label', 'cfg_thing.a'],
    ['a resource through a local', 'region = local.r', 'local.r -> cfg_thing.a'],
    ['a resource a data source waits for', 'region = data.local_file.d.content', 'data.local_file.d -> cfg_thing.a'],
  ])('refuses %s, at the value it writes', async (_title, value, chain) => {
    const config = `locals { r = cfg_thing.a.label }\ndata "local_file" "d" {\n  path = "${path.join(dir, 'd.txt')}"\n  depends_on = [cfg_thing.a]\n}\nprovider "cfg" {\n  ${value}\n}\n${THING_A}`;

    const error = await engine()
      .plan(config)
      .catch((error_: unknown) => error_);

    expect(error).toMatchObject({
      message: `provider "cfg" reads ${chain}, but a provider block reads no resource or module: it is configured before the resources it makes`,
      position: { line: 7 },
    });
  });

  it('refuses a resource a variable’s validation reads', async () => {
    const config = `variable "r" {\n  default = "eu"\n  validation {\n    condition = var.r != cfg_thing.a.label\n    error_message = "taken"\n  }\n}\nprovider "cfg" { region = var.r }\n${THING_A}`;

    await expect(engine().plan(config)).rejects.toThrow('provider "cfg" reads var.r -> cfg_thing.a, but');
  });

  it('refuses a module output', async () => {
    await fs.mkdir(path.join(dir, 'm'));
    await fs.writeFile(path.join(dir, 'm', 'main.clay'), 'output "r" { value = "eu" }');

    await expect(engine().plan('module "m" { source = "./m" }\nprovider "cfg" { region = module.m.r }')).rejects.toThrow('provider "cfg" reads module.m, but');
  });

  it('refuses a block in a module, which uses its caller’s', async () => {
    await fs.mkdir(path.join(dir, 'm'));
    await fs.writeFile(path.join(dir, 'm', 'main.clay'), 'provider "cfg" { region = "eu" }');

    await expect(engine().plan('module "m" { source = "./m" }')).rejects.toThrow(
      'module "m" has a provider "cfg" block, which only the root configuration can: a module uses its caller\'s providers'
    );
  });

  it('refuses a block that reads a data source of its own provider, at the value it writes', async () => {
    const error = await engine()
      .plan('data "cfg_data" "d" { label = "eu" }\nprovider "cfg" { region = data.cfg_data.d.label }')
      .catch((error_: unknown) => error_);

    expect(error).toMatchObject({ message: expect.stringContaining('provider "cfg"'), position: { line: 2 } });
    expect((error as Error).message).toContain('Dependency cycle detected');
  });

  it('hides why configure failed when a value it was given is sensitive', async () => {
    await expect(engine().plan(`provider "cfg" {\n  region = "eu"\n  token = "s3cret"\n}\n${THING_A}`)).rejects.toThrow(
      'provider "cfg" failed to configure; a value given to it is sensitive, so the reason is not shown'
    );
  });

  it('refuses a configuration schema that computes a value, which is a bug in the provider', async () => {
    const computed: Schema = { region: { type: types.string, computed: true } };

    await expect(engine(computed).plan('provider "cfg" {}')).rejects.toThrow('provider "cfg" gives region computed, but only a resource takes it, which is a bug in the provider');
  });

  it('is checked by validate with a value not known yet, and configures nothing', async () => {
    await engine().validate(`variable "r" {}\nprovider "cfg" { region = var.r }\n${THING_A}`);

    expect(log).toEqual([]);
  });

  it('is held to its schema by validate', async () => {
    await expect(engine().validate(`provider "cfg" {\n  regoin = "eu"\n}`)).rejects.toThrow('provider "cfg" has no attribute "regoin"');
  });

  describe('in a destroy', () => {
    const block = 'variable "r" {}\nprovider "cfg" { region = var.r }\n';
    const given = [{ from: 'var' as const, name: 'r', text: 'eu' }];

    const destroy = async (config: string, variables = given) => {
      const strict = engine();
      const planned = await strict.plan(config, { destroy: true, variables });
      for await (const event of strict.runPlan(planned, config)) if (event.type === 'failed') throw event.error;
      return planned;
    };

    beforeEach(async () => {
      const made = engine();
      const config = block + THING_A;
      for await (const event of made.runPlan(await made.plan(config, { variables: given }), config)) if (event.type === 'failed') throw event.error;
      log.length = 0;
      await fs.writeFile(path.join(dir, 'zone.txt'), 'x');
    });

    it('configures the plan and the apply with what the block reads, from the values the plan kept', async () => {
      const planned = await destroy(block + THING_A);

      expect(planned.actions.map(({ type }) => type)).toEqual(['DELETE']);
      expect(log).toEqual([{ region: 'eu' }, { region: 'eu' }]);
    });

    // Each reads the variable only through the way it names, so a destroy that did not follow it would find the variable not declared.
    it.each([
      [
        'the count of a data source',
        'variable "n" { default = 1 }\ndata "local_file" "z" {\n  count = var.n\n  path = "DIR/zone.txt"\n}\nprovider "cfg" { region = data.local_file.z[0].content }',
      ],
      [
        'the for_each of a data source',
        'variable "names" { default = ["zone.txt"] }\ndata "local_file" "z" {\n  for_each = toset(var.names)\n  path = "DIR/${each.value}"\n}\nprovider "cfg" { region = data.local_file.z["zone.txt"].content }',
      ],
      [
        'the validation of a variable',
        'variable "other" { default = "y" }\nvariable "z" {\n  default = "x"\n  validation {\n    condition = var.z != var.other\n    error_message = "same"\n  }\n}\nprovider "cfg" { region = var.z }',
      ],
    ])('works out what the block reads through %s', async (_title, config) => {
      await destroy(config.replaceAll('DIR', dir), []);

      expect(log).toEqual([{ region: 'x' }, { region: 'x' }]);
    });

    it('needs no value only the rest reads, and is not stopped by a mistake in the rest', async () => {
      await destroy(`${block}variable "unused" {}\nresource "cfg_thing" "a" { label = var.missing }\n`);

      expect(log).toEqual([{ region: 'eu' }, { region: 'eu' }]);
    });
  });
});
