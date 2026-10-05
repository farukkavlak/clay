import { DiskFiles, Orchestrator, RunEvent } from '@clay/orchestrator';
import { ConfigError } from '@clay/parser';
import { parsePlanFile, Plan, serializePlan } from '@clay/planner';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

class CountingProvider extends LocalProvider {
  reads = 0;

  override async readDataSource(type: string, inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.reads += 1;
    return await super.readDataSource(type, inputs);
  }
}

const outputsOf = (events: RunEvent[]) => {
  const done = events.find((event) => event.type === 'done');
  return Object.fromEntries(Object.entries(done?.outputs ?? {}).map(([name, output]) => [name, output.value]));
};

describe('data source values in the plan', () => {
  let dir: string;
  let size: string;

  const newOrchestrator = (provider = new LocalProvider()) => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(provider);
    return engine;
  };

  const run = async (saved: Plan, config: string, engine = newOrchestrator()): Promise<RunEvent[]> => {
    const events: RunEvent[] = [];
    for await (const event of engine.runPlan(saved, config)) {
      if (event.type === 'failed') throw event.error;
      events.push(event);
    }
    return events;
  };

  const savedToFile = async (config: string) => parsePlanFile(serializePlan(await newOrchestrator().plan(config), config, {}), 'plan.json');

  const read = () => `data "local_file" "size" { path = "${size}" }\noutput "read" { value = data.local_file.size.content }\n`;

  const logs = (repeat: string, key: string) => `
    resource "local_file" "logs" {
      ${repeat}
      path = "${path.join(dir, `log-\${${key}}.txt`)}"
      content = "x"
    }
  `;

  const counted = () => `${read()}${logs('count = length(data.local_file.size.content)', 'count.index')}`;

  const files = async () => {
    const names = await fs.readdir(dir, { recursive: true });
    return names.filter((name) => name.endsWith('.txt')).sort();
  };

  const stateKeys = async () => {
    const state = await new LocalBackend(dir).read();
    return Object.keys(state.resources).sort();
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-data-values-'));
    size = path.join(dir, 'size');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('reads a data source once for a plan and its apply', async () => {
    const provider = new CountingProvider();
    const engine = newOrchestrator(provider);
    await fs.writeFile(size, 'ab');

    await run(await engine.plan(counted()), counted(), engine);

    expect(provider.reads).toBe(1);
    expect(await files()).toEqual(['log-0.txt', 'log-1.txt']);
  });

  it('applies a plan saved to a file with what its data source gave, though the source is gone', async () => {
    await fs.writeFile(size, 'ab');
    const saved = await savedToFile(counted());
    await fs.rm(size);

    const events = await run(saved, counted());

    expect(outputsOf(events)).toEqual({ read: 'ab' });
    expect(await files()).toEqual(['log-0.txt', 'log-1.txt']);
  });

  it.each([
    ['longer', 'abc'],
    ['shorter', 'a'],
  ])('makes the instances the plan showed when the file its count reads is %s by the apply', async (_, later) => {
    await fs.writeFile(size, 'ab');
    const saved = await newOrchestrator().plan(counted());
    await fs.writeFile(size, later);

    const events = await run(saved, counted());

    expect(outputsOf(events)).toEqual({ read: 'ab' });
    expect(await files()).toEqual(['log-0.txt', 'log-1.txt']);
    expect(await stateKeys()).toEqual(['local_file.logs[0]', 'local_file.logs[1]']);
  });

  it('deletes the index the plan showed, though the file its count reads gives it again by the apply', async () => {
    await fs.writeFile(size, 'abc');
    await run(await newOrchestrator().plan(counted()), counted());
    await fs.writeFile(size, 'ab');
    const saved = await newOrchestrator().plan(counted());
    await fs.writeFile(size, 'abc');

    const events = await run(saved, counted());

    expect(outputsOf(events)).toEqual({ read: 'ab' });
    expect(await files()).toEqual(['log-0.txt', 'log-1.txt']);
    expect(await stateKeys()).toEqual(['local_file.logs[0]', 'local_file.logs[1]']);
  });

  it('makes the keys the plan showed when the file its for_each reads has changed by the apply', async () => {
    const config = `${read()}${logs('for_each = toset([data.local_file.size.content])', 'each.key')}`;
    await fs.writeFile(size, 'ab');
    const saved = await newOrchestrator().plan(config);
    await fs.writeFile(size, 'cd');

    await run(saved, config);

    expect(await files()).toEqual(['log-ab.txt']);
    expect(await stateKeys()).toEqual(['local_file.logs["ab"]']);
  });

  it('makes the instances the plan showed in a module whose count reads the file', async () => {
    await fs.mkdir(path.join(dir, 'm'));
    await fs.writeFile(path.join(dir, 'm', 'main.clay'), `variable "n" {}\n${logs('count = var.n', 'count.index')}`);
    const config = `${read()}module "m" {\n  source = "./m"\n  for_each = ["a"]\n  n = length(data.local_file.size.content)\n}`;
    await fs.writeFile(size, 'ab');
    const saved = await newOrchestrator().plan(config);
    await fs.writeFile(size, 'a');

    await run(saved, config);

    expect(await files()).toEqual(['log-0.txt', 'log-1.txt']);
    expect(await stateKeys()).toEqual(['module.m["a"].local_file.logs[0]', 'module.m["a"].local_file.logs[1]']);
  });

  it('refuses a plan with no value for a data source the configuration declares, and points at it', async () => {
    await fs.writeFile(size, 'ab');
    const saved = await newOrchestrator().plan(counted());

    const error = await run({ ...saved, dataSources: {} }, counted()).catch((error_: unknown) => error_);

    expect(error).toBeInstanceOf(ConfigError);
    expect(error).toMatchObject({
      message: 'The plan has no value for data.local_file.size, which the configuration declares',
      position: { line: 1, column: 1 },
      block: 'data "local_file" "size"',
    });
    expect(await files()).toEqual([]);
  });
});
