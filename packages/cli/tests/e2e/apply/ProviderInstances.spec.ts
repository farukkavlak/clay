import { planFromSchema, PlannedChange, PlanRequest, Provider, Schema, types } from '@clay/provider';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { orchestratorIn } from '../helpers';
import { start } from '../start';

const SCHEMA: Schema = { label: { type: types.string, required: true } };

/** Refuses every call until it is configured, and notes each call with the instance it came to. */
class Strict implements Provider {
  static made = 0;
  readonly name: string = 'strict';
  readonly resources = ['strict_thing'];
  readonly dataSources = ['strict_data'];
  private readonly id = ++Strict.made;
  private configured = false;

  constructor(private readonly log: string[]) {}

  /** Slow, so a call that does not wait for it comes first. */
  async configure(): Promise<void> {
    this.log.push(`${this.id} configure`);
    await setTimeout(20);
    this.configured = true;
  }

  private asked(call: string): void {
    if (!this.configured) throw new Error(`${call} asked of an instance not configured`);
    this.log.push(`${this.id} ${call}`);
  }

  async getSchema(): Promise<Schema> {
    return SCHEMA;
  }

  async validate(): Promise<void> {}

  async plan(_type: string, request: PlanRequest): Promise<PlannedChange> {
    this.asked('plan');
    return planFromSchema(SCHEMA, request);
  }

  async read(_type: string, prior: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    this.asked('read');
    return prior;
  }

  async create(_type: string, { config }: { config: Record<string, unknown> }): Promise<Record<string, unknown>> {
    this.asked('create');
    return config;
  }

  async update(_type: string, { config }: { config: Record<string, unknown> }): Promise<Record<string, unknown>> {
    this.asked('update');
    return config;
  }

  async delete(): Promise<void> {
    this.asked('delete');
  }

  async getDataSourceSchema(): Promise<Schema> {
    return SCHEMA;
  }

  async validateDataSource(): Promise<void> {}

  async readDataSource(_type: string, inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.asked('readDataSource');
    return inputs;
  }
}

/** Nothing in the configuration or the state needs it. */
class Unused extends Strict {
  override readonly name: string = 'unused';
  override readonly resources = ['unused_thing'];
  override readonly dataSources: string[] = [];
}

const THING = 'resource "strict_thing" "a" { label = data.strict_data.d.label }\ndata "strict_data" "d" { label = "x" }';

describe('the instances of a provider', () => {
  let dir: string;
  let log: string[];

  const engine = (...more: (() => Provider)[]) => orchestratorIn(dir, () => new Strict(log), ...more);

  const apply = async (config: string) => {
    for await (const event of start(engine(), config)) if (event.type === 'failed') throw event.error;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-instances-'));
    log = [];
    Strict.made = 0;
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  // The one made when it is registered answers only what a provider is; the apply reuses what the plan read.
  it('configures a new instance in each run, before the run asks it anything', async () => {
    await apply(THING);

    expect(log).toEqual(['2 configure', '2 readDataSource', '2 plan', '3 configure', '3 plan', '3 create']);
  });

  it('configures one for an object the configuration dropped, to read it back and destroy it', async () => {
    await apply(THING);
    log.length = 0;

    await apply('');

    expect(log).toEqual(['5 configure', '5 read', '6 configure', '6 delete']);
  });

  it('configures one for validate, which plans', async () => {
    await engine().validate(THING);

    expect(log).toEqual(['2 configure', '2 plan']);
  });

  it('configures no provider that nothing needs', async () => {
    const unused: string[] = [];
    await engine(() => new Unused(unused)).plan(THING);

    expect(unused).toEqual([]);
  });

  // Each block is freed by what it reads, not by its provider, which every block of its types waits for.
  it('lists the blocks in the order of what they read, apart from their provider', async () => {
    const file = (name: string, content: string) => `resource "local_file" "${name}" {\n path = "${path.join(dir, name)}"\n content = ${content}\n}\n`;
    const config = file('a', '"a"') + 'variable "x" {\n default = "x"\n}\n' + file('c', 'local_file.a.content') + file('b', 'var.x');

    const { actions } = await orchestratorIn(dir).plan(config);

    expect(actions.map(({ name }) => name)).toEqual(['a', 'c', 'b']);
  });

  it('reports the failure that comes first in the order of what the blocks read', async () => {
    const config = `data "local_file" "d" {\n path = "${path.join(dir, 'missing.txt')}"\n}\nvariable "v" {\n default = "x"\n validation {\n condition = var.v == "y"\n error_message = "bad var"\n }\n}\n`;

    await expect(orchestratorIn(dir).plan(config)).rejects.toThrow('missing.txt');
  });

  it('names the provider whose configure failed', async () => {
    const failing = Object.assign(new Strict(log), {
      configure: async () => {
        throw new Error('no credentials');
      },
    });

    await expect(orchestratorIn(dir, () => failing).plan(THING)).rejects.toThrow('provider "strict": no credentials');
  });

  it('stops an apply whose provider fails to configure, and names it', async () => {
    let runs = 0;
    const later = () =>
      Object.assign(
        new Strict(log),
        runs++ < 2
          ? {}
          : {
              configure: async () =>
                Promise.resolve().then(() => {
                  throw new Error('token expired');
                }),
            }
      );
    const strict = orchestratorIn(dir, later);
    const planned = await strict.plan(THING);

    await expect(async () => {
      for await (const event of strict.runPlan(planned, THING)) if (event.type === 'failed') throw event.error;
    }).rejects.toThrow('provider "strict": token expired');
  });
});
