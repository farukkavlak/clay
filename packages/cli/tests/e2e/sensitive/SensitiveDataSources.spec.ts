import { CreateRequest, PlannedChange, PlanRequest, planFromSchema, Provider, Schema, State, types } from '@clay/contracts';

import { parsePlanFile, serializePlan } from '@clay/planner';
import { LocalProvider } from '@clay/provider-local';

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { orchestratorIn } from '../helpers';

const REFUSED = (name: string) => `output "${name}" holds a sensitive value; write sensitive = true to export it`;

/** Reads back the tags it is given. */
class Tagged implements Provider {
  readonly resources: string[] = [];
  readonly dataSources = ['tagged'];

  async getSchema(): Promise<Schema> {
    return {};
  }

  async plan(_type: string, request: PlanRequest): Promise<PlannedChange> {
    return planFromSchema({}, request);
  }

  async validate(): Promise<void> {}
  async read(_type: string, prior: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    return prior;
  }

  async create(_type: string, { config }: CreateRequest): Promise<Record<string, unknown>> {
    return config;
  }

  async update(_type: string, { config }: CreateRequest): Promise<Record<string, unknown>> {
    return config;
  }

  async delete(): Promise<void> {}

  async getDataSourceSchema(): Promise<Schema> {
    return { tags: { type: types.map(types.string), optional: true } };
  }

  async validateDataSource(): Promise<void> {}

  async readDataSource(_type: string, config: Record<string, unknown>): Promise<Record<string, unknown>> {
    return config;
  }
}

const drain = async (events: AsyncGenerator<{ type: string; error?: Error }>) => {
  for await (const event of events) if (event.type === 'failed') throw event.error;
};

// The module hides the path of a file that exists.
const reading = (output = '') => `
  module "db" { source = "./db" }
  data "local_file" "f" { path = module.db.path }
  ${output}
`;

// The resource is made in this plan, so the data source reads after it, at apply.
const readingLater = (output = '') => `
  module "db" { source = "./db" }
  resource "local_file" "w" {
    path    = module.db.path
    content = "hi"
  }
  data "local_file" "f" { path = local_file.w.path }
  ${output}
`;

const copy = (dir: string, value: string) => `
  resource "local_file" "copy" {
    path    = "${path.join(dir, 'copy.txt')}"
    content = ${value}
  }
`;

const tagged = (output = '') => `
  module "db" { source = "./db" }
  data "tagged" "t" { tags = { name = "app", token = module.db.path } }
  ${output}
`;

describe('a data source given a sensitive value', () => {
  let dir: string;

  const newOrchestrator = () => orchestratorIn(dir, new LocalProvider(), new Tagged());

  const apply = async (config: string, engine = newOrchestrator()) => {
    await drain(engine.runPlan(await engine.plan(config), config));
  };

  const marks = async (address: string) => {
    const state = JSON.parse(await fs.readFile(path.join(dir, 'clay.state.json'), 'utf8')) as State;

    return state.resources[address].sensitive;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-sensitive-data-'));
    await fs.mkdir(path.join(dir, 'db'));
    await fs.writeFile(path.join(dir, 'secret.txt'), 'hi', 'utf8');
    await fs.writeFile(path.join(dir, 'db', 'main.clay'), `output "path" {\n  value     = "${path.join(dir, 'secret.txt')}"\n  sensitive = true\n}\n`, 'utf8');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  describe('read at plan', () => {
    it.each([
      ['the attribute it was given to', 'data.local_file.f.path'],
      ['the whole data source', 'data.local_file.f'],
    ])('keeps %s sensitive', async (_, value) => {
      const config = reading(`output "probe" { value = ${value} }`);

      await expect(newOrchestrator().plan(config)).rejects.toThrow(REFUSED('probe'));
      await expect(newOrchestrator().validate(config)).rejects.toThrow(REFUSED('probe'));
    });

    it('leaves what the provider computes plain', async () => {
      const { outputs } = await newOrchestrator().plan(reading('output "probe" { value = data.local_file.f.content }'));

      expect(outputs.probe.new?.value).toBe('hi');
    });

    it('lets a sensitive output show the value as hidden', async () => {
      const { outputs } = await newOrchestrator().plan(reading('output "probe" {\n  value = data.local_file.f.path\n  sensitive = true\n}'));

      expect(outputs.probe.new?.sensitive).toBe(true);
    });

    it('keeps it through a plan saved to a file, into what a resource is given', async () => {
      const config = reading(copy(dir, 'data.local_file.f.path'));
      const saved = parsePlanFile(serializePlan(await newOrchestrator().plan(config), config, {}), 'plan.json');
      await drain(newOrchestrator().runPlan(saved, config));

      expect(await marks('local_file.copy')).toEqual([['content']]);
    });

    it('marks no more than the plan file says', async () => {
      const config = reading(copy(dir, 'data.local_file.f.content'));
      const saved = parsePlanFile(serializePlan(await newOrchestrator().plan(config), config, {}), 'plan.json');
      await drain(newOrchestrator().runPlan(saved, config));

      expect(await marks('local_file.copy')).toBeUndefined();
    });
  });

  describe('read at apply', () => {
    it('is left for the apply by the plan', async () => {
      const plan = await newOrchestrator().plan(readingLater());

      expect(plan.readAtApply).toEqual(['data.local_file.f']);
      expect(plan.dataSources).toEqual({});
    });

    it.each([
      ['the attribute it was given to', 'data.local_file.f.path'],
      ['the whole data source', 'data.local_file.f'],
    ])('keeps %s sensitive in a plan, before the read', async (_, value) => {
      const config = readingLater(`output "probe" { value = ${value} }`);

      await expect(newOrchestrator().plan(config)).rejects.toThrow(REFUSED('probe'));
      await expect(newOrchestrator().validate(config)).rejects.toThrow(REFUSED('probe'));
    });

    it('keeps it into what a resource is given, once read', async () => {
      await apply(readingLater(copy(dir, 'data.local_file.f.path')));

      expect(await marks('local_file.copy')).toEqual([['content']]);
    });

    it('marks no more than what was given', async () => {
      await apply(readingLater(copy(dir, 'data.local_file.f.content')));

      expect(await marks('local_file.copy')).toBeUndefined();
    });
  });

  describe('given a map in which one key is sensitive', () => {
    it.each([
      ['the sensitive key', 'data.tagged.t.tags.token'],
      ['the map', 'data.tagged.t.tags'],
    ])('keeps %s sensitive', async (_, value) => {
      await expect(newOrchestrator().plan(tagged(`output "probe" { value = ${value} }`))).rejects.toThrow(REFUSED('probe'));
    });

    it('leaves another key plain', async () => {
      const { outputs } = await newOrchestrator().plan(tagged('output "probe" { value = data.tagged.t.tags.name }'));

      expect(outputs.probe.new?.value).toBe('app');
    });

    it('keeps the key sensitive through a plan saved to a file, and only that key', async () => {
      const config = tagged(copy(dir, 'data.tagged.t.tags.token'));
      const saved = parsePlanFile(serializePlan(await newOrchestrator().plan(config), config, {}), 'plan.json');
      expect(saved.dataSensitive).toEqual({ 'data.tagged.t': [['tags', 'token']] });
      await drain(newOrchestrator().runPlan(saved, config));
      expect(await marks('local_file.copy')).toEqual([['content']]);

      const other = tagged(copy(dir, 'data.tagged.t.tags.name'));
      await drain(newOrchestrator().runPlan(parsePlanFile(serializePlan(await newOrchestrator().plan(other), other, {}), 'plan.json'), other));
      expect(await marks('local_file.copy')).toBeUndefined();
    });
  });

  describe.each([
    ['count', 'count = 1', '0'],
    ['for_each', 'for_each = { a = 1 }', '"a"'],
  ])('with %s', (_, repeat, key) => {
    const repeated = (output = '') => `
      module "db" { source = "./db" }
      data "local_file" "f" {
        ${repeat}
        path = module.db.path
      }
      ${output}
    `;

    it.each([
      ['every instance', 'data.local_file.f'],
      ['one instance', `data.local_file.f[${key}]`],
      ['the attribute of one instance', `data.local_file.f[${key}].path`],
    ])('keeps %s sensitive', async (_, value) => {
      const config = repeated(`output "probe" { value = ${value} }`);

      await expect(newOrchestrator().plan(config)).rejects.toThrow(REFUSED('probe'));
      await expect(newOrchestrator().validate(config)).rejects.toThrow(REFUSED('probe'));
    });

    it('leaves what the provider computes plain', async () => {
      const { outputs } = await newOrchestrator().plan(repeated(`output "probe" { value = data.local_file.f[${key}].content }`));

      expect(outputs.probe.new?.value).toBe('hi');
    });

    it('keeps it through a plan saved to a file', async () => {
      const config = repeated(copy(dir, `data.local_file.f[${key}].path`));
      const saved = parsePlanFile(serializePlan(await newOrchestrator().plan(config), config, {}), 'plan.json');
      await drain(newOrchestrator().runPlan(saved, config));

      expect(await marks('local_file.copy')).toEqual([['content']]);
    });
  });
});
