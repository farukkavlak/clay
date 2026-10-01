import { CreateRequest, ExactNumber, planFromSchema, PlannedChange, PlanRequest, Provider, Schema } from '@clay/contracts';
import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { start } from './start';

/** Counts to a `total` only the apply makes, a number, and keeps `labels`, a map of strings. */
class TallyProvider implements Provider {
  readonly resources = ['tally'];
  readonly dataSources: string[] = [];

  async getSchema(): Promise<Schema> {
    return {
      id: { type: 'string', computed: true, kept: true },
      total: { type: 'number', computed: true },
      labels: { type: 'map', elemType: 'string' },
    };
  }

  async plan(_type: string, request: PlanRequest): Promise<PlannedChange> {
    return planFromSchema(await this.getSchema(), request);
  }

  async validate(): Promise<void> {}

  async read(_type: string, prior: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    return prior;
  }

  async create(_type: string, { planned }: CreateRequest): Promise<Record<string, unknown>> {
    return { ...planned, id: 'tally', total: ExactNumber.parse('3') };
  }

  async update(): Promise<Record<string, unknown>> {
    throw new Error('a tally is never changed');
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

describe('a configuration held to the schema', () => {
  let dir: string;
  let file: string;

  const newOrchestrator = () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    engine.registerProvider(new TallyProvider());
    return engine;
  };

  const apply = async (config: string) => {
    for await (const event of start(newOrchestrator(), config)) if (event.type === 'failed') throw event.error;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-schema-'));
    file = path.join(dir, 'a.txt');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('plans what the schema takes, as written', async () => {
    const { actions } = await newOrchestrator().plan(`resource "null_resource" "n" {\n  triggers = { a = "x" }\n}`);

    expect(actions.map(({ after }) => after?.triggers)).toEqual([{ a: 'x' }]);
  });

  it('refuses a name the resource does not have, where it is written', async () => {
    const config = `resource "local_file" "a" {\n  path = "${file}"\n  content = "hi"\n  contnet = "x"\n}`;

    await expect(newOrchestrator().plan(config)).rejects.toMatchObject({
      message: 'local_file has no attribute "contnet"',
      position: { file: 'main.clay', line: 4, column: 13 },
      block: 'resource "local_file" "a"',
    });
  });

  // A name does not hang on a value, so it is checked once for the block, even one that makes no instance.
  it('refuses a name the resource does not have in a block with count = 0', async () => {
    const config = `resource "local_file" "a" {\n  count = 0\n  path = "${file}"\n  content = "hi"\n  contnet = "x"\n}`;

    await expect(newOrchestrator().plan(config)).rejects.toThrow('local_file has no attribute "contnet"');
  });

  it('refuses a resource without a value it requires, at the block', async () => {
    await expect(newOrchestrator().plan('resource "local_file" "a" {\n  content = "hi"\n}')).rejects.toMatchObject({
      message: 'local_file requires "path"',
      position: { file: 'main.clay', line: 1, column: 1 },
    });
  });

  it('refuses a value of a type the resource does not take, where it is written', async () => {
    await expect(newOrchestrator().plan('resource "local_file" "a" {\n  path    = "a.txt"\n  content = 5\n}')).rejects.toMatchObject({
      message: 'content is a number, where local_file takes a string',
      position: { file: 'main.clay', line: 3, column: 13 },
      block: 'resource "local_file" "a"',
    });
  });

  it('refuses an item of a type the resource does not take', async () => {
    await expect(newOrchestrator().plan('resource "tally" "t" {\n  labels = { a = [1] }\n}')).rejects.toThrow('labels["a"] is a list, where tally takes a string');
  });

  // A value the apply makes used to leave the whole resource unchecked.
  it('checks a known value beside one the apply makes', async () => {
    const config = `resource "random_string" "r" { length = 4 }\nresource "local_file" "a" {\n  path    = random_string.r.result\n  content = 5\n}`;

    await expect(newOrchestrator().plan(config)).rejects.toThrow('content is a number, where local_file takes a string');
  });

  it('checks a known item beside one the apply makes', async () => {
    const config = `resource "random_string" "r" { length = 4 }\nresource "tally" "t" {\n  labels = { a = random_string.r.result, b = true }\n}`;

    await expect(newOrchestrator().plan(config)).rejects.toThrow('labels["b"] is a boolean, where tally takes a string');
  });

  it('refuses at apply a value the plan did not know, once it is known, before the provider is sent it', async () => {
    const config = `resource "tally" "t" {}\nresource "local_file" "a" {\n  path    = "${file}"\n  content = tally.t.total\n}`;

    await expect(apply(config)).rejects.toThrow('content is a number, where local_file takes a string');
    await expect(fs.access(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('a data block held to the schema', () => {
  let dir: string;
  let file: string;

  const plan = (config: string) => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    return engine.plan(config);
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-data-schema-'));
    file = path.join(dir, 'a.txt');
    await fs.writeFile(file, 'hi');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('reads what the schema takes', async () => {
    const { outputs } = await plan(`data "local_file" "f" { path = "${file}" }\noutput "c" { value = data.local_file.f.content }`);

    expect(outputs).toEqual({ c: { old: undefined, new: 'hi' } });
  });

  // Each is refused before the file is read, so the path need not be there.
  it.each([
    ['a name it does not have', '  path    = "a.txt"\n  contnet = "x"', 'local_file has no attribute "contnet"', { line: 3, column: 13 }],
    ['a name written in place of one it requires', '  paht = "a.txt"', 'local_file has no attribute "paht"', { line: 2, column: 10 }],
    ['a value of a type it does not take', '  path = 5', 'path is a number, where local_file takes a string', { line: 2, column: 10 }],
    ['a value it computes', '  path    = "a.txt"\n  content = "x"', 'content is computed by local_file and cannot be set', { line: 3, column: 13 }],
  ])('refuses %s, where it is written', async (_, body, message, at) => {
    await expect(plan(`data "local_file" "f" {\n${body}\n}`)).rejects.toMatchObject({
      message,
      position: { file: 'main.clay', ...at },
      block: 'data "local_file" "f"',
    });
  });

  it('refuses a block without a value it requires, at the block', async () => {
    await expect(plan('\ndata "local_file" "f" {}')).rejects.toMatchObject({
      message: 'local_file requires "path"',
      position: { file: 'main.clay', line: 2, column: 1 },
    });
  });

  // The names are checked before any value is resolved, so the wrong name is what is reported.
  it('refuses a name it does not have before a value in it that does not resolve', async () => {
    await expect(plan(`data "local_file" "f" {\n  path    = "${file}"\n  contnet = var.missing\n}`)).rejects.toThrow('local_file has no attribute "contnet"');
  });
});
