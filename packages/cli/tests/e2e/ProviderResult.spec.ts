import { CreateRequest, planFromSchema, PlannedChange, PlanRequest, Provider, Schema, types, UNKNOWN, UpdateRequest } from '@clay/contracts';
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
    return { label: { type: types.string, required: true } };
  }

  async plan(_type: string, request: PlanRequest): Promise<PlannedChange> {
    return planFromSchema(await this.getSchema(), request);
  }

  async validate(): Promise<void> {}

  async read(_type: string, prior: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    return prior;
  }

  async create(_type: string, { config }: CreateRequest): Promise<Record<string, unknown>> {
    return { label: String(config.label).toUpperCase(), volume: 'high' };
  }

  async update(_type: string, _request: UpdateRequest): Promise<Record<string, unknown>> {
    return {};
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

/** Makes what it is told to and reads back what it was given, with `extra` added to it. */
class EchoProvider extends LoudProvider {
  override readonly resources = ['echo'];

  constructor(private extra: Record<string, unknown> = {}) {
    super();
  }

  override async create(_type: string, { config }: CreateRequest): Promise<Record<string, unknown>> {
    return config;
  }

  override async read(_type: string, prior: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    return { ...prior, ...this.extra };
  }
}

/** Reads a data source whose schema holds the content it reads, and returns what it is told to. */
class DataReader extends LoudProvider {
  override readonly resources: string[] = [];
  override readonly dataSources = ['vague'];

  constructor(
    private returned: Record<string, unknown>,
    private schema: Schema = { content: { type: types.string, computed: true } }
  ) {
    super();
  }

  override async getDataSourceSchema(): Promise<Schema> {
    return this.schema;
  }

  override async readDataSource(): Promise<Record<string, unknown>> {
    return this.returned;
  }
}

/** Makes and changes a resource with a `note` it names and gives no value. */
class NotelessProvider extends LoudProvider {
  override readonly resources = ['noteless'];

  override async getSchema(): Promise<Schema> {
    return { label: { type: types.string, required: true }, note: { type: types.string, computed: true, optional: true } };
  }

  override async create(_type: string, { config }: CreateRequest): Promise<Record<string, unknown>> {
    return { ...config, note: undefined };
  }

  override async update(_type: string, { config }: UpdateRequest): Promise<Record<string, unknown>> {
    return { ...config, note: undefined };
  }
}

/** Says it keeps a value it does not compute. */
class MuddledEcho extends EchoProvider {
  override async getSchema(): Promise<Schema> {
    return { label: { type: types.string, required: true, kept: true } };
  }
}

/** Plans its id from the name it is given, then makes it with another. */
class MisnamingProvider extends LoudProvider {
  override readonly resources = ['named'];

  override async getSchema(): Promise<Schema> {
    return { name: { type: types.string, required: true }, id: { type: types.string, computed: true, kept: true } };
  }

  override async plan(_type: string, request: PlanRequest): Promise<PlannedChange> {
    const { after, replace } = planFromSchema(await this.getSchema(), request);
    return { after: { ...after, id: request.config.name }, replace };
  }

  override async create(_type: string, { config }: CreateRequest): Promise<Record<string, unknown>> {
    return { ...config, id: `${String(config.name)}-123` };
  }
}

/** Plans its label as a list, where its schema names a string. */
class MistypingProvider extends LoudProvider {
  override async plan(_type: string, request: PlanRequest): Promise<PlannedChange> {
    const { after, replace } = planFromSchema(await this.getSchema(), request);
    return { after: { ...after, label: [after.label] }, replace };
  }
}

/** Plans its id with a count of the plans it made, so no two plans agree. */
class FickleProvider extends MisnamingProvider {
  private plans = 0;

  override async plan(_type: string, request: PlanRequest): Promise<PlannedChange> {
    const { after, replace } = planFromSchema(await this.getSchema(), request);
    this.plans += 1;
    return { after: { ...after, id: `plan-${this.plans}` }, replace };
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
    expect(state.resources['loud.a'].attributes).toEqual({ label: 'QUIET', volume: 'high' });
    expect(Object.keys(state.resources)).toEqual(['loud.a']);
    await expect(fs.access(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('stops the run at a resource made with an id other than the plan showed', async () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new MisnamingProvider());

    const failures: Error[] = [];
    for await (const event of start(engine, 'resource "named" "a" { name = "logs" }')) if (event.type === 'failed') failures.push(event.error);

    expect(failures.map(({ message }) => message)).toEqual([
      'named returned what the plan did not show, which is a bug in the provider:\n  id = "logs-123", where the plan showed "logs"',
    ]);
  });
});

describe('the plan made again at apply', () => {
  let dir: string;

  const failuresOf = async (config: string, ...providers: Provider[]) => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    for (const provider of providers) engine.registerProvider(provider);

    const failures: string[] = [];
    for await (const event of start(engine, config)) if (event.type === 'failed') failures.push(event.error.message);
    return failures;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-final-plan-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  // The name is not known at plan, so the plan cannot know the id; the plan at apply can.
  it('holds what the apply returns to what the provider plans once the values are known', async () => {
    const failures = await failuresOf(
      `
        resource "random_string" "n" { length = 4 }
        resource "named" "a" { name = random_string.n.result }
      `,
      new MisnamingProvider()
    );

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/^named returned what the plan did not show, which is a bug in the provider:\n {2}id = "(\w{4})-123", where the plan showed "\1"$/);
  });

  it('stops before anything is made when the provider plans at apply what the plan did not show', async () => {
    const failures = await failuresOf('resource "named" "a" { name = "logs" }', new FickleProvider());

    expect(failures).toEqual(['named planned at apply what the plan did not show, which is a bug in the provider:\n  id = "plan-2", where the plan showed "plan-1"']);
    const state = await new LocalBackend(dir).read();
    expect(state.resources).toEqual({});
  });

  it('makes a file whose path is known only at apply, with its path as its id', async () => {
    const failures = await failuresOf(
      `
        resource "random_string" "n" { length = 4 }
        resource "local_file" "a" {
          path    = "${dir}/\${random_string.n.result}.txt"
          content = "hi"
        }
      `
    );

    expect(failures).toEqual([]);
    const state = await new LocalBackend(dir).read();
    const { attributes } = state.resources['local_file.a'];
    expect(attributes.id).toBe(attributes.path);
    expect(await fs.readFile(String(attributes.id), 'utf8')).toBe('hi');
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
    ['a name the provider made up', { volume: 'high' }, 'volume = "high", which the schema does not have'],
    ['a value not known', { label: UNKNOWN }, 'label is not known; a read returns every value'],
  ])('refuses %s, at the resource', async (_, extra, line) => {
    const config = 'resource "echo" "a" { label = "a" }';
    await apply(config);

    await expect(newOrchestrator(new EchoProvider(extra)).plan(config)).rejects.toThrow(
      `echo.a: echo read what the resource cannot hold, which is a bug in the provider:\n  ${line}`
    );
  });

  // A name with no value is one left out, so it is not a name the provider made up.
  it('takes a name the read gives no value as one it left out', async () => {
    const config = 'resource "echo" "a" { label = "a" }';
    await apply(config);

    const { actions } = await newOrchestrator(new EchoProvider({ volume: undefined })).plan(config);

    expect(actions.map((action) => action.type)).toEqual(['NO_OP']);
  });

  it('refuses a value of another type than its schema names, at the resource', async () => {
    const config = 'resource "echo" "a" { label = "a" }';
    await apply(config);

    await expect(newOrchestrator(new EchoProvider({ label: ['a'] })).plan(config)).rejects.toThrow(
      'echo.a: echo read what its schema does not hold, which is a bug in the provider: label is a list, where its type is a string'
    );
  });
});

const noteless = (label: string) => `resource "noteless" "a" { label = "${label}" }\noutput "note" { value = noteless.a.note }`;

describe('a name an apply returns with no value', () => {
  let dir: string;

  const newOrchestrator = () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new NotelessProvider());
    return engine;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-valueless-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  // The output reads it in the same run, from what the apply returned, before any state file drops it.
  it.each([
    ['a create', []],
    ['an update', ['old']],
  ])('is a name %s left out, read as null in the same run', async (_, before) => {
    for (const label of [...before, 'new']) for await (const event of start(newOrchestrator(), noteless(label))) if (event.type === 'failed') throw event.error;

    const state = await new LocalBackend(dir).read();
    expect(state.resources['noteless.a'].attributes).toEqual({ label: 'new' });
    expect(state.outputs).toEqual({ note: { value: null, type: types.string } });
    const plan = await newOrchestrator().plan(noteless('new'));
    expect(plan.actions.map((action) => action.type)).toEqual(['NO_OP']);
  });
});

describe('what a provider plans, held to its schema', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-plan-result-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('refuses a value of another type than its schema names, at the resource', async () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new MistypingProvider());

    await expect(engine.plan('\nresource "loud" "a" { label = "a" }')).rejects.toMatchObject({
      message: 'loud planned what its schema does not hold, which is a bug in the provider: label is a list, where its type is a string',
      position: { file: 'main.clay', line: 2, column: 1 },
    });
  });
});

describe('what a data source reads', () => {
  let dir: string;

  const plan = (reader: DataReader) => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(reader);
    return engine.plan('\ndata "vague" "v" {}');
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-data-result-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it.each([
    ['a value not known', { content: UNKNOWN }, 'content is not known; a read returns every value'],
    ['a name its schema does not have', { content: 'x', size: 'big' }, 'size = "big", which the schema does not have'],
  ])('refuses %s, at the data block', async (_, returned, line) => {
    await expect(plan(new DataReader(returned))).rejects.toMatchObject({
      message: `vague read what the data source cannot hold, which is a bug in the provider:\n  ${line}`,
      position: { file: 'main.clay', line: 2, column: 1 },
    });
  });

  it('takes a name the read gives no value as one it left out', async () => {
    await expect(plan(new DataReader({ content: 'x', size: undefined }))).resolves.toMatchObject({ actions: [] });
  });

  // Left out, given no value and given null are the one thing to what reads it.
  it.each([
    ['leaves out', {}],
    ['gives no value', { content: undefined }],
    ['gives null', { content: null }],
  ])('reads as null a name its schema has that the read %s', async (_, returned) => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new DataReader(returned));

    const { outputs } = await engine.plan('data "vague" "v" {}\noutput "content" { value = data.vague.v.content }');

    expect(outputs).toEqual({ content: { old: undefined, new: { value: null, type: types.string } } });
  });

  it('refuses a name its schema does not have, where it is read', async () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new DataReader({ content: 'x' }));

    await expect(engine.plan('data "vague" "v" {}\noutput "size" { value = data.vague.v.size }')).rejects.toThrow('Attribute "size" not found on data source "data.vague.v"');
  });

  it('refuses a value of another type than its schema names, at the data block', async () => {
    await expect(plan(new DataReader({ content: ['x'] }))).rejects.toMatchObject({
      message: 'vague read what its schema does not hold, which is a bug in the provider: content is a list, where its type is a string',
      position: { file: 'main.clay', line: 2, column: 1 },
    });
  });

  it('refuses a schema that says when to remake it, at the data block, before it is read', async () => {
    const reader = new DataReader({ content: UNKNOWN }, { content: { type: types.string, computed: true, forceNew: true } });

    await expect(plan(reader)).rejects.toMatchObject({
      message: 'data source vague marks content forceNew, but only a resource can be forceNew, which is a bug in the provider',
      position: { file: 'main.clay', line: 2, column: 1 },
      block: 'data "vague" "v"',
    });
  });
});

describe('a schema a provider gives', () => {
  let dir: string;

  const newOrchestrator = (echo: EchoProvider) => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(echo);
    return engine;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-schema-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const refused = 'echo keeps label, which it does not compute; only a computed value can be kept, which is a bug in the provider';

  it('is refused where it keeps a value it does not compute, at the resource', async () => {
    await expect(newOrchestrator(new MuddledEcho()).plan('\nresource "echo" "a" { label = "a" }')).rejects.toMatchObject({
      message: refused,
      position: { file: 'main.clay', line: 2, column: 1 },
    });
  });

  it('is refused the same way when the refresh reads it', async () => {
    const config = 'resource "echo" "a" { label = "a" }';
    for await (const event of start(newOrchestrator(new EchoProvider()), config)) if (event.type === 'failed') throw event.error;

    await expect(newOrchestrator(new MuddledEcho()).plan(config)).rejects.toThrow(`echo.a: ${refused}`);
  });
});
