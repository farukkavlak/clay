import { CreateRequest, Identity, planFromSchema, PlannedChange, PlanRequest, Provider, Schema, types } from '@clay/contracts';
import { parsePlanFile, serializePlan } from '@clay/planner';
import { LocalProvider } from '@clay/provider-local';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { growth, LINEAR } from '../../../../../tests/growth';
import { displayPlan } from '../../../src/showPlan';
import { clayOutput, orchestratorIn } from '../helpers';
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

const POOL: Schema = { id: { type: types.string, computed: true, kept: true }, members: { type: types.set(types.string) } };

/** Holds a set of members, and returns them in reverse, as a remote API may. */
class Pool implements Provider {
  readonly resources = ['pool'];
  readonly dataSources = [];

  async getSchema(): Promise<Schema> {
    return POOL;
  }

  async plan(_type: string, request: PlanRequest): Promise<PlannedChange> {
    return planFromSchema(POOL, request);
  }

  async validate(): Promise<void> {}

  async read(_type: string, prior: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    return prior;
  }

  async create(_type: string, { planned }: CreateRequest): Promise<Record<string, unknown>> {
    return { ...planned, id: 'pool', members: Array.isArray(planned.members) ? [...planned.members].reverse() : planned.members };
  }

  async update(type: string, request: CreateRequest): Promise<Record<string, unknown>> {
    return this.create(type, request);
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

/** A pool whose members are `size` strings, each `prefix` and its index. */
const pool = (size: number, prefix: string) =>
  `variable "xs" {\n  default = [${Array.from({ length: size }, (_, index) => `"${prefix}${index}"`).join(', ')}]\n}\nresource "pool" "p" {\n  members = var.xs\n}\n`;

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

/** `size` instances of `b`, each reading its own instance of `a`. */
const chain = (size: number) =>
  `resource "null_resource" "a" {\n  count = ${size}\n}\nresource "null_resource" "b" {\n  count    = ${size}\n  triggers = { a = null_resource.a[count.index].id }\n}\n`;

/** A resource whose `triggers` hold `size` keys, each given the value `value` says. */
const keyed = (size: number, value: string) =>
  `variable "ks" {\n  default = [${Array.from({ length: size }, (_, index) => `"k${index}"`).join(', ')}]\n}\nresource "null_resource" "r" {\n  triggers = { for k in var.ks : k => ${value} }\n}\n`;

const SENSITIVE_KEYS = 'sensitive(k)';

/** Plans and shows `size` sensitive keys of which one is no longer sensitive, and returns how long that took. */
const showSensitiveKeysChanged = async (at: string, size: number) => {
  await apply(at, keyed(size, SENSITIVE_KEYS));
  const engine = orchestratorIn(at);

  return timed(async () => displayPlan(await engine.plan(keyed(size, `k == "k0" ? "plain" : ${SENSITIVE_KEYS}`))));
};

/** A resource whose `triggers` look up each of `size` keys in a map of `size` sensitive keys. */
const lookedUp = (size: number) => `${keyed(size, 'lookup(local.m, k, "")')}locals {\n  m = { for k in var.ks : k => ${SENSITIVE_KEYS} }\n}\n`;

/** A resource `s` whose `triggers` hold `size` keys, each given the value `value` says, and a resource whose `triggers` read each of them from `s`. */
const readEach = (size: number, value: string) =>
  `${keyed(size, 'null_resource.s.triggers[k]')}resource "null_resource" "s" {\n  triggers = { for k in var.ks : k => ${value} }\n}\n`;

/** A resource `s` with `size` instances, and `size` instances of a resource whose `triggers` read how many `s` has. */
const readAll = (size: number) =>
  `resource "null_resource" "s" {\n  count = ${size}\n}\nresource "null_resource" "r" {\n  count    = ${size}\n  triggers = { n = length(null_resource.s) }\n}\n`;

const readAllData = (file: string, size: number) =>
  `data "local_file" "f" {\n  count = ${size}\n  path  = "${file}"\n}\nresource "null_resource" "r" {\n  count    = ${size}\n  triggers = { n = length(data.local_file.f) }\n}\n`;

const readAllModule = (size: number) =>
  `module "m" {\n  source = "./m"\n  count  = ${size}\n}\nresource "null_resource" "r" {\n  count    = ${size}\n  triggers = { n = length(module.m) }\n}\n`;

/** Plans, shows and applies through a plan file a pool of `size` members changed to `size` others, and returns how long that took. */
const changeEveryMember = async (at: string, size: number) => {
  await apply(at, pool(size, 'a'), new Pool());
  const config = pool(size, 'b');
  const engine = orchestratorIn(at, new Pool());

  return timed(async () => {
    const saved = parsePlanFile(serializePlan(await engine.plan(config), { 'main.clay': config }), 'plan.json');
    displayPlan(saved);
    let applied = 0;
    for await (const event of engine.runPlan(saved, config)) {
      if (event.type === 'failed') throw event.error;
      if (event.type === 'applied') applied += 1;
    }
    expect(applied).toBe(1);
  });
};

// Each case grew by 3 to 4.5 here, and by 13 to 18 when it walked every instance.
const GENEROUS = { timeout: 60_000 };

describe('a run over many instances', () => {
  let dir: string;

  /** A fresh directory for each run, under the test's own. */
  const sized = async (size: number) => {
    const at = await fs.mkdtemp(path.join(dir, `${size}-`));
    await fs.mkdir(path.join(at, 'm'), { recursive: true });
    await fs.writeFile(path.join(at, 'm', 'main.clay'), 'resource "null_resource" "x" {}\n', 'utf8');
    return at;
  };

  /** How many times longer `run` takes at four times `size`, each run in a fresh directory; `run` says what it times. Three rounds, as each takes seconds. */
  const growthIn = (size: number, run: (at: string, size: number) => Promise<number>) => growth(size, async (each) => run(await sized(each), each), 3);

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-scale-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('reads the instances of a data source in time that grows with them', GENEROUS, async () => {
    const run = async (at: string, size: number) => {
      await fs.writeFile(path.join(at, 'f.txt'), 'x', 'utf8');
      const config = `data "local_file" "f" {\n  count = ${size}\n  path  = "${path.join(at, 'f.txt')}"\n}\nresource "null_resource" "r" {}\n`;
      return timed(async () => expect(await apply(at, config)).toBe(1));
    };

    expect(await growthIn(2500, run)).toBeLessThan(LINEAR);
  });

  it('makes a resource in each instance of a module in time that grows with them', GENEROUS, async () => {
    const run = (at: string, size: number) => timed(async () => expect(await apply(at, `module "m" {\n  source = "./m"\n  count  = ${size}\n}\n`)).toBe(size));

    expect(await growthIn(2000, run)).toBeLessThan(LINEAR);
  });

  it('claims objects a provider identifies in time that grows with them', GENEROUS, async () => {
    const run = (at: string, size: number) =>
      timed(async () => expect(await apply(at, `resource "thing" "t" {\n  count = ${size}\n  name  = "t\${count.index}"\n}\n`, new Things(), new LocalProvider())).toBe(size));

    expect(await growthIn(2000, run)).toBeLessThan(LINEAR);
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

    expect(await growthIn(25_000, run)).toBeLessThan(LINEAR);
  });

  it('plans a for object with one key not known yet in time that grows with its items', GENEROUS, async () => {
    const run = (at: string, size: number) => {
      const items = Array.from({ length: size }, (_, index) => index).join(', ');
      const config = `variable "xs" {\n  default = [${items}]\n}\nresource "null_resource" "r" {}\noutput "n" {\n  value = length({ for x in var.xs : (x == 0 ? null_resource.r.id : "\${x}") => x })\n}\n`;

      return timed(async () => {
        let outputs: Record<string, { value: unknown }> = {};
        for await (const event of start(orchestratorIn(at), config)) if (event.type === 'done') outputs = event.outputs;
        expect(String(outputs.n.value)).toBe(String(size));
      });
    };

    expect(await growthIn(6000, run)).toBeLessThan(LINEAR);
  });

  it('moves the instances of a module in time that grows with them', GENEROUS, async () => {
    const run = async (at: string, size: number) => {
      await apply(at, `module "m" {\n  source = "./m"\n  count  = ${size}\n}\n`);

      return timed(async () => expect(await apply(at, `moved {\n  from = module.m\n  to   = module.n\n}\nmodule "n" {\n  source = "./m"\n  count  = ${size}\n}\n`)).toBe(size));
    };

    expect(await growthIn(1000, run)).toBeLessThan(LINEAR);
  });

  it('destroys instances that each read a block in time that grows with them', GENEROUS, async () => {
    const run = async (at: string, size: number) => {
      await apply(at, chain(size));

      return timed(async () => expect(await apply(at, '')).toBe(size * 2));
    };

    expect(await growthIn(500, run)).toBeLessThan(LINEAR);
  });

  it('destroys a chain that what stays read in state in time that grows with it', GENEROUS, async () => {
    const run = async (at: string, size: number) => {
      await apply(at, `${chain(size)}resource "null_resource" "c" {\n  count    = ${size}\n  triggers = { b = null_resource.b[count.index].id }\n}\n`);

      return timed(async () => expect(await apply(at, `resource "null_resource" "c" {\n  count = ${size}\n}\n`)).toBe(size * 3));
    };

    expect(await growthIn(1000, run)).toBeLessThan(LINEAR);
  });

  it('shows and applies a change to every member of a set in time that grows with them', GENEROUS, async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await growthIn(1000, changeEveryMember)).toBeLessThan(LINEAR);
  });

  it('shows a change to a value with many sensitive keys in time that grows with them', GENEROUS, async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await growthIn(2000, showSensitiveKeysChanged)).toBeLessThan(LINEAR);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('triggers: {"k0":(sensitive value),"k1":(sensitive value)'));
    expect(log).toHaveBeenCalledWith('      triggers: which parts are sensitive changes');
  });

  it('plans a lookup of each key of a map with many sensitive keys in time that grows with them', GENEROUS, async () => {
    let sensitive: unknown;
    const run = (at: string, size: number) =>
      timed(async () => {
        const { actions } = await orchestratorIn(at).plan(lookedUp(size));
        ({ sensitive } = actions[0]);
      });

    expect(await growthIn(4000, run)).toBeLessThan(LINEAR);
    expect(sensitive).toEqual(
      expect.arrayContaining([
        ['triggers', 'k0'],
        ['triggers', 'k15999'],
      ])
    );
  });

  it('plans the length of a map for each of its keys in time that grows with them', GENEROUS, async () => {
    let triggers: Record<string, unknown> = {};
    const run = (at: string, size: number) =>
      timed(async () => {
        const { actions } = await orchestratorIn(at).plan(`${keyed(size, 'length(local.m)')}locals {\n  m = { for k in var.ks : k => k }\n}\n`);
        triggers = actions[0].after?.triggers as Record<string, unknown>;
      });

    expect(await growthIn(2000, run)).toBeLessThan(LINEAR);
    expect(JSON.stringify([triggers.k0, triggers.k7999])).toBe('[8000,8000]');
  });

  it('shows in state a value with many sensitive keys in time that grows with them', GENEROUS, async () => {
    let shown = '';
    const run = async (at: string, size: number) => {
      await apply(at, keyed(size, SENSITIVE_KEYS));
      return timed(async () => (shown = await clayOutput(at, 'state', 'show', 'null_resource.r')));
    };

    expect(await growthIn(4000, run)).toBeLessThan(LINEAR);
    expect(shown).toContain('{"k0":(sensitive value),"k1":(sensitive value)');
  });

  it('plans a read of each key of a resource with many sensitive keys in time that grows with them', GENEROUS, async () => {
    let sensitive: unknown;
    const run = (at: string, size: number) =>
      timed(async () => {
        const { actions } = await orchestratorIn(at).plan(readEach(size, SENSITIVE_KEYS));
        ({ sensitive } = actions.find(({ name }) => name === 'r') ?? {});
      });

    expect(await growthIn(1000, run)).toBeLessThan(LINEAR);
    expect(sensitive).toEqual(
      expect.arrayContaining([
        ['triggers', 'k0'],
        ['triggers', 'k3999'],
      ])
    );
  });

  it('plans from state a read of each key of a resource in time that grows with them', GENEROUS, async () => {
    let types: string[] = [];
    const run = async (at: string, size: number) => {
      await apply(at, readEach(size, 'k'));
      return timed(async () => {
        const { actions } = await orchestratorIn(at).plan(readEach(size, 'k'));
        types = actions.map(({ type }) => type);
      });
    };

    expect(await growthIn(1000, run)).toBeLessThan(LINEAR);
    expect(types).toEqual(['NO_OP', 'NO_OP']);
  });

  it('plans instances that each read every instance of a resource in time that grows with them', GENEROUS, async () => {
    let triggers: unknown;
    const run = (at: string, size: number) =>
      timed(async () => {
        const { actions } = await orchestratorIn(at).plan(readAll(size));
        ({ triggers } = actions.find(({ name, key }) => name === 'r' && key === size - 1)?.after ?? {});
      });

    expect(await growthIn(1000, run)).toBeLessThan(LINEAR);
    expect(JSON.stringify(triggers)).toBe('{"n":4000}');
  });

  it('plans instances that each read every instance of a data source in time that grows with them', GENEROUS, async () => {
    let triggers: unknown;
    const run = async (at: string, size: number) => {
      const file = path.join(at, 'f.txt');
      await fs.writeFile(file, 'x', 'utf8');
      return timed(async () => {
        const { actions } = await orchestratorIn(at).plan(readAllData(file, size));
        ({ triggers } = actions.find(({ name, key }) => name === 'r' && key === size - 1)?.after ?? {});
      });
    };

    expect(await growthIn(1000, run)).toBeLessThan(LINEAR);
    expect(JSON.stringify(triggers)).toBe('{"n":4000}');
  });

  it('plans instances that each read every instance of a module in time that grows with them', GENEROUS, async () => {
    let triggers: unknown;
    const run = async (at: string, size: number) => {
      await fs.writeFile(path.join(at, 'm', 'main.clay'), 'output "o" {\n  value = "x"\n}\n', 'utf8');
      return timed(async () => {
        const { actions } = await orchestratorIn(at).plan(readAllModule(size));
        ({ triggers } = actions.find(({ name, key }) => name === 'r' && key === size - 1)?.after ?? {});
      });
    };

    expect(await growthIn(1000, run)).toBeLessThan(LINEAR);
    expect(JSON.stringify(triggers)).toBe('{"n":4000}');
  });
});
