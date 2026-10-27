import { CreateRequest, Identity, planFromSchema, PlannedChange, PlanRequest, Provider, Schema, types } from '@clay/contracts';
import { LocalProvider } from '@clay/provider-local';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { orchestratorIn } from '../helpers';
import { start } from '../start';

const SCHEMA: Schema = { name: { type: types.string, required: true } };

/** Each object is the thing its name says, so the engine asks which object is which. */
class Things implements Provider {
  readonly resources = ['thing'];
  readonly dataSources = [];

  async getSchema(): Promise<Schema> {
    return SCHEMA;
  }

  async plan(_type: string, request: PlanRequest): Promise<PlannedChange> {
    return planFromSchema(SCHEMA, request);
  }

  async validate(): Promise<void> {}

  async read(_type: string, prior: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    return prior;
  }

  async create(_type: string, { config }: CreateRequest): Promise<Record<string, unknown>> {
    return { ...config };
  }

  async update(_type: string, { config }: CreateRequest): Promise<Record<string, unknown>> {
    return { ...config };
  }

  async delete(): Promise<void> {}

  async getDataSourceSchema(): Promise<Schema> {
    return {};
  }

  async validateDataSource(): Promise<void> {}

  async readDataSource(): Promise<Record<string, unknown>> {
    return {};
  }

  async identify(_type: string, values: Record<string, unknown>): Promise<Identity | undefined> {
    return { key: `thing ${String(values.name)}`, name: `thing ${String(values.name)}` };
  }
}

/** Milliseconds `work` takes. */
async function timed(work: () => Promise<unknown>): Promise<number> {
  const started = performance.now();
  await work();
  return performance.now() - started;
}

const apply = async (at: string, config: string, ...providers: Provider[]) => {
  let applied = 0;
  for await (const event of start(orchestratorIn(at, ...providers), config)) {
    if (event.type === 'failed') throw event.error;
    if (event.type === 'applied') applied += 1;
  }
  return applied;
};

/**
 * How much longer a run takes on four times the instances: about four where it grows with them, sixteen where each walked every other.
 * A ratio, so a loaded machine slows both runs alike. Each case grew by 3 to 4.5 here, and by 13 to 18 when it walked every instance.
 */
const LINEAR = 8;
const GENEROUS = { timeout: 60_000 };

describe('a run over many instances', () => {
  let dir: string;

  /** A fresh directory for each size, under the test's own. */
  const sized = async (size: number) => {
    const at = path.join(dir, String(size));
    await fs.mkdir(path.join(at, 'm'), { recursive: true });
    await fs.writeFile(path.join(at, 'm', 'main.clay'), 'resource "null_resource" "x" {}\n', 'utf8');
    return at;
  };

  /** The time `run` takes at four times `size` over the time at `size`; `run` says what it times. */
  const growth = async (size: number, run: (at: string, size: number) => Promise<number>) => {
    const small = await run(await sized(size), size);
    const large = await run(await sized(size * 4), size * 4);
    return large / small;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-scale-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('reads the instances of a data source in time that grows with them', GENEROUS, async () => {
    const run = async (at: string, size: number) => {
      await fs.writeFile(path.join(at, 'f.txt'), 'x', 'utf8');
      const config = `data "local_file" "f" {\n  count = ${size}\n  path  = "${path.join(at, 'f.txt')}"\n}\nresource "null_resource" "r" {}\n`;
      return timed(async () => expect(await apply(at, config)).toBe(1));
    };

    expect(await growth(2500, run)).toBeLessThan(LINEAR);
  });

  it('makes a resource in each instance of a module in time that grows with them', GENEROUS, async () => {
    const run = (at: string, size: number) => timed(async () => expect(await apply(at, `module "m" {\n  source = "./m"\n  count  = ${size}\n}\n`)).toBe(size));

    expect(await growth(2000, run)).toBeLessThan(LINEAR);
  });

  it('claims objects a provider identifies in time that grows with them', GENEROUS, async () => {
    const run = (at: string, size: number) =>
      timed(async () => expect(await apply(at, `resource "thing" "t" {\n  count = ${size}\n  name  = "t\${count.index}"\n}\n`, new Things(), new LocalProvider())).toBe(size));

    expect(await growth(2000, run)).toBeLessThan(LINEAR);
  });

  it('groups items under one key in time that grows with them', GENEROUS, async () => {
    const run = (at: string, size: number) => {
      const items = Array.from({ length: size }, (_, index) => index).join(', ');
      const config = `variable "xs" {\n  default = [${items}]\n}\noutput "n" {\n  value = length({ for x in var.xs : "k" => x... }["k"])\n}\n`;

      return timed(async () => {
        let outputs: Record<string, { value: unknown }> = {};
        for await (const event of start(orchestratorIn(at), config)) if (event.type === 'done') outputs = event.outputs;
        expect(String(outputs.n.value)).toBe(String(size));
      });
    };

    expect(await growth(25_000, run)).toBeLessThan(LINEAR);
  });

  it('moves the instances of a module in time that grows with them', GENEROUS, async () => {
    const run = async (at: string, size: number) => {
      await apply(at, `module "m" {\n  source = "./m"\n  count  = ${size}\n}\n`);

      return timed(async () => expect(await apply(at, `moved {\n  from = module.m\n  to   = module.n\n}\nmodule "n" {\n  source = "./m"\n  count  = ${size}\n}\n`)).toBe(size));
    };

    expect(await growth(1000, run)).toBeLessThan(LINEAR);
  });
});
