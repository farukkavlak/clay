import { CreateRequest, planFromSchema, PlannedChange, PlanRequest, Provider, Schema, State, types, UpdateRequest } from '@clay/contracts';
import { DiskFiles, Orchestrator, RunEvent } from '@clay/orchestrator';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { start } from '../start';

const SCHEMA: Schema = {
  name: { type: types.string, required: true, forceNew: true },
  note: { type: types.string, optional: true },
};

/** Notes each create, update and destroy in the order they happen. A name in `failing` cannot be made or destroyed. */
class Rec implements Provider {
  readonly resources = ['rec'];
  readonly dataSources = [];
  readonly seen: string[] = [];
  failingCreate = new Set<string>();
  failingDelete = new Set<string>();
  failingUpdate = new Set<string>();

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
    const name = String(config.name);
    if (this.failingCreate.has(name)) throw new Error(`${name} cannot be made`);

    this.seen.push(`create ${name}`);
    return { ...config };
  }

  async update(_type: string, { config }: UpdateRequest): Promise<Record<string, unknown>> {
    if (this.failingUpdate.has(String(config.name))) throw new Error(`${String(config.name)} cannot be updated`);

    this.seen.push(`update ${String(config.name)}`);
    return { ...config };
  }

  async delete(_type: string, prior: Record<string, unknown>): Promise<void> {
    const name = String(prior.name);
    if (this.failingDelete.has(name)) throw new Error(`${name} cannot be destroyed`);

    this.seen.push(`delete ${name}`);
  }

  async getDataSourceSchema(): Promise<Schema> {
    return {};
  }

  async validateDataSource(): Promise<void> {}

  async readDataSource(): Promise<Record<string, unknown>> {
    return {};
  }
}

const rec = (name: string, label: string, ...body: string[]) => `resource "rec" "${name}" {\n  name = "${label}"\n${body.map((line) => `  ${line}\n`).join('')}}`;

const lifecycle = '  lifecycle {\n    create_before_destroy = true\n  }';

const called = (label: string) => `module "m" {\n  source = "./m"\n  count  = 2\n  label  = "${label}"\n}\n`;

const reader = (label: string) => `${rec('a', label, lifecycle)}\n${rec('b', 'b', 'note = rec.a.name')}`;
const reading = (label: string) => `${rec('a', label)}\n${rec('b', 'b', 'note = rec.a.name', lifecycle)}`;
const through = (label: string) => `${rec('a', label)}\n${rec('b', 'b', 'note = rec.a.name')}\n${rec('c', 'c', 'note = rec.b.name', lifecycle)}`;

describe('create_before_destroy', () => {
  let dir: string;
  let provider: Rec;
  let engine: Orchestrator;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-first-'));
    provider = new Rec();
    engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(provider);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const run = async (config: string): Promise<RunEvent[]> => {
    const events: RunEvent[] = [];
    for await (const event of start(engine, config)) events.push(event);

    return events;
  };

  const applied = async (config: string) => {
    const events = await run(config);
    const failed = events.find((event) => event.type === 'failed');
    if (failed) throw failed.error;

    provider.seen.length = 0;
  };

  const state = async () => JSON.parse(await fs.readFile(path.join(dir, 'clay.state.json'), 'utf8')) as State;
  const held = async (address: string) => {
    const found = await state();
    return found.resources[address]?.attributes.name;
  };
  const deposedNames = async (address: string) => {
    const found = await state();
    return found.deposed?.[address]?.map((object) => object.attributes.name);
  };

  it('creates the new object, and destroys the old one after', async () => {
    await applied(rec('a', 'a1', lifecycle));

    await run(rec('a', 'a2', lifecycle));

    expect(provider.seen).toEqual(['create a2', 'delete a1']);
    expect(await held('rec.a')).toBe('a2');
    expect(await deposedNames('rec.a')).toBeUndefined();
  });

  it('keeps the old order where the block does not say it', async () => {
    await applied(rec('a', 'a1'));

    await run(rec('a', 'a2'));

    expect(provider.seen).toEqual(['delete a1', 'create a2']);
  });

  it('keeps the old order where the block says false', async () => {
    await applied(rec('a', 'a1', '  lifecycle {\n    create_before_destroy = false\n  }'));

    await run(rec('a', 'a2', '  lifecycle {\n    create_before_destroy = false\n  }'));

    expect(provider.seen).toEqual(['delete a1', 'create a2']);
  });

  it('destroys the old object only after what depends on the replaced one is updated', async () => {
    await applied(reader('a1'));

    await run(reader('a2'));

    expect(provider.seen).toEqual(['create a2', 'update b', 'delete a1']);
  });

  it('forces it on what a resource with it depends on, though the dependency does not say it', async () => {
    await applied(reading('a1'));

    await run(reading('a2'));

    expect(provider.seen).toEqual(['create a2', 'update b', 'delete a1']);
  });

  it('reaches a dependency through another resource', async () => {
    await applied(through('a1'));

    await run(through('a2'));

    expect(provider.seen).toEqual(['create a2', 'update b', 'delete a1']);
  });

  describe('when it fails', () => {
    it('leaves the old object whole where the new one cannot be made', async () => {
      await applied(rec('a', 'a1', lifecycle));
      provider.failingCreate.add('a2');

      const events = await run(rec('a', 'a2', lifecycle));

      expect(events.at(-1)?.type).toBe('failed');
      expect(provider.seen).toEqual([]);
      expect(await held('rec.a')).toBe('a1');
      expect(await deposedNames('rec.a')).toBeUndefined();
    });

    it('keeps the old object deposed where it cannot be destroyed, and the next run destroys it', async () => {
      await applied(rec('a', 'a1', lifecycle));
      provider.failingDelete.add('a1');

      const events = await run(rec('a', 'a2', lifecycle));

      expect(events.at(-1)).toMatchObject({ type: 'failed' });
      expect(await held('rec.a')).toBe('a2');
      expect(await deposedNames('rec.a')).toEqual(['a1']);

      provider.failingDelete.clear();
      provider.seen.length = 0;
      const again = await run(rec('a', 'a2', lifecycle));

      expect(again.filter((event) => event.type === 'failed')).toEqual([]);
      expect(provider.seen).toEqual(['delete a1']);
      expect(await deposedNames('rec.a')).toBeUndefined();
    });
  });

  it('destroys the oldest deposed object first when a second replace comes before the first was destroyed', async () => {
    await applied(rec('a', 'a1', lifecycle));
    provider.failingDelete.add('a1');
    await run(rec('a', 'a2', lifecycle));
    await run(rec('a', 'a3', lifecycle));
    expect(await deposedNames('rec.a')).toEqual(['a1', 'a2']);

    provider.failingDelete.clear();
    provider.seen.length = 0;
    await run(rec('a', 'a3', lifecycle));

    expect(provider.seen).toEqual(['delete a1', 'delete a2']);
    expect(await held('rec.a')).toBe('a3');
  });

  it('leaves the old object deposed for the next plan where a later layer fails', async () => {
    await applied(reader('a1'));
    provider.failingUpdate.add('b');

    const events = await run(reader('a2'));

    expect(events.at(-1)?.type).toBe('failed');
    expect(provider.seen).toEqual(['create a2']);
    expect(await held('rec.a')).toBe('a2');
    expect(await deposedNames('rec.a')).toEqual(['a1']);

    provider.failingUpdate.clear();
    provider.seen.length = 0;
    await run(reader('a2'));

    expect(provider.seen).toEqual(['update b', 'delete a1']);
  });

  it('creates first in every instance of a module whose resource says it', async () => {
    await fs.mkdir(path.join(dir, 'm'));
    await fs.writeFile(path.join(dir, 'm', 'main.clay'), `variable "label" {}\n${rec('x', '${var.label}', lifecycle)}\n`, 'utf8');
    await applied(called('l1'));

    await run(called('l2'));

    expect(provider.seen).toEqual(['create l2', 'create l2', 'delete l1', 'delete l1']);
  });

  it('is shown as a replace whose new object is made first, and counts one add and one destroy', async () => {
    await applied(rec('a', 'a1', lifecycle));

    const events = await run(rec('a', 'a2', lifecycle));

    const replaced = events.find((event) => event.type === 'applied' && event.action.type === 'REPLACE');
    expect(replaced).toMatchObject({ action: { createBeforeDestroy: true } });
    expect(events.filter((event) => event.type === 'applied' && event.action.deposed)).toHaveLength(1);
  });
});
