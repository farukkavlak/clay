import { types } from '@clay/contracts';
import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { CONFIG_FILE } from '@clay/parser';
import { parsePlanFile, Plan, serializePlan } from '@clay/planner';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('a data source with count', () => {
  let dir: string;

  const newOrchestrator = () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    return engine;
  };

  const run = async (saved: Plan, config: string): Promise<Record<string, unknown>> => {
    let outputs: Record<string, unknown> = {};

    for await (const event of newOrchestrator().runPlan(saved, config)) {
      if (event.type === 'failed') throw event.error;
      if (event.type === 'done') outputs = Object.fromEntries(Object.entries(event.outputs).map(([name, output]) => [name, output.value]));
    }
    return outputs;
  };

  const apply = async (config: string) => run(await newOrchestrator().plan(config), config);

  // Read as f0.txt, f1.txt and so on, by index.
  const reads = (count: number | string) => `data "local_file" "f" {\n  count = ${count}\n  path  = "${dir}/f\${count.index}.txt"\n}\n`;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-data-count-'));
    await fs.writeFile(path.join(dir, 'f0.txt'), 'zero', 'utf8');
    await fs.writeFile(path.join(dir, 'f1.txt'), 'one', 'utf8');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('reads one instance for each index, each read by its index', async () => {
    const config = `${reads(2)}output "second" { value = data.local_file.f[1].content }\noutput "all" { value = [for f in data.local_file.f : f.content] }`;

    const outputs = await apply(config);

    expect(outputs).toEqual({ second: 'one', all: ['zero', 'one'] });
  });

  it('reads every instance, named alone, as a list by index', async () => {
    const config = `${reads(2)}output "whole" { value = data.local_file.f }`;

    const { outputs } = await newOrchestrator().plan(config);

    expect(outputs.whole.new?.value).toEqual([
      { path: `${dir}/f0.txt`, content: 'zero' },
      { path: `${dir}/f1.txt`, content: 'one' },
    ]);
    expect(outputs.whole.new?.type).toEqual(types.list(types.object({ path: types.string, content: types.string })));
  });

  it('types every instance as a list where it is read as written', async () => {
    const config = `${reads(2)}resource "local_file" "copy" {\n  count   = 0\n  path    = "copy.txt"\n  content = data.local_file.f\n}`;

    await expect(newOrchestrator().validate(config)).rejects.toMatchObject({
      message: 'content is a list, where local_file takes a string',
      position: { file: CONFIG_FILE, line: 8, column: 13 },
    });
  });

  it('reads nothing with count = 0', async () => {
    const config = `${reads(0)}output "whole" { value = data.local_file.f }`;

    const plan = await newOrchestrator().plan(config);

    expect(plan.outputs.whole.new?.value).toEqual([]);
    expect(plan.dataSources).toEqual({});
  });

  it('names each instance by its index in the plan, and runs from the plan file', async () => {
    const config = `${reads(2)}output "second" { value = data.local_file.f[1].content }`;

    const saved = parsePlanFile(serializePlan(await newOrchestrator().plan(config), config, {}), 'plan.json');

    expect(Object.keys(saved.dataSources)).toEqual(['data.local_file.f[0]', 'data.local_file.f[1]']);
    expect(await run(saved, config)).toEqual({ second: 'one' });
  });

  it('is read for each index in each instance of its module', async () => {
    await fs.mkdir(path.join(dir, 'm'));
    await fs.writeFile(path.join(dir, 'm', 'main.clay'), `${reads(2)}output "all" { value = [for f in data.local_file.f : f.content] }`, 'utf8');
    const config = 'module "m" {\n  count  = 2\n  source = "./m"\n}\noutput "all" { value = [for m in module.m : m.all] }';

    const plan = await newOrchestrator().plan(config);

    expect(Object.keys(plan.dataSources)).toEqual([
      'module.m[0].data.local_file.f[0]',
      'module.m[0].data.local_file.f[1]',
      'module.m[1].data.local_file.f[0]',
      'module.m[1].data.local_file.f[1]',
    ]);
    expect(plan.outputs.all.new?.value).toEqual([
      ['zero', 'one'],
      ['zero', 'one'],
    ]);
  });

  it('waits for the apply at each index when what it reads changes, and reads each by its own index', async () => {
    // Empty, so the path is f0.txt and f1.txt, read only once it is made.
    const marker = `resource "local_file" "marker" {\n  path    = "${dir}/marker.txt"\n  content = ""\n}\n`;
    const config = `${marker}data "local_file" "f" {\n  count = 2\n  path  = "${dir}/f\${count.index}.txt\${local_file.marker.content}"\n}\noutput "all" { value = [for f in data.local_file.f : f.content] }`;

    const plan = await newOrchestrator().plan(config);

    expect(plan.readAtApply).toEqual(['data.local_file.f[0]', 'data.local_file.f[1]']);
    expect(await run(plan, config)).toEqual({ all: ['zero', 'one'] });
  });

  it.each([
    ['an index past its count', 'data.local_file.f[2].content', 'data.local_file.f has 2 instances, [0] to [1]'],
    ['no index', 'data.local_file.f.content', 'data.local_file.f has count, so name one of it by index, as in data.local_file.f[0]'],
  ])('refuses %s', async (_, read, message) => {
    const config = `${reads(2)}output "o" { value = ${read} }`;

    await expect(newOrchestrator().plan(config)).rejects.toMatchObject({ message, position: { file: CONFIG_FILE, line: 5, column: 22 } });
  });

  it('refuses count.index in a data source with no count', async () => {
    const config = `data "local_file" "f" { path = "\${count.index}.txt" }`;

    await expect(newOrchestrator().plan(config)).rejects.toMatchObject({
      message: 'count.index is only known inside a resource, a data source or a module call that has count',
      block: 'data "local_file" "f"',
      position: { file: CONFIG_FILE, line: 1, column: 35 },
    });
  });

  it('refuses an index past its count in each instance of its module', async () => {
    await fs.mkdir(path.join(dir, 'm'));
    await fs.writeFile(path.join(dir, 'm', 'main.clay'), `${reads(2)}output "o" { value = data.local_file.f[5].content }`, 'utf8');

    await expect(newOrchestrator().plan('module "m" {\n  count  = 2\n  source = "./m"\n}')).rejects.toMatchObject({
      message: 'data.local_file.f has 2 instances, [0] to [1]',
      position: { file: path.join('m', 'main.clay'), line: 5, column: 22 },
    });
  });

  it('refuses a count not known when planning', async () => {
    const writes = `resource "local_file" "a" {\n  path    = "${dir}/a.txt"\n  content = "made"\n}\ndata "local_file" "read" { path = local_file.a.path }\n`;
    const config = `${writes}${reads('length(data.local_file.read.content)')}`;

    await expect(newOrchestrator().plan(config)).rejects.toMatchObject({
      message: 'count must be known when planning: it reads a value only an apply makes',
      block: 'data "local_file" "f"',
      position: { file: CONFIG_FILE, line: 7, column: 11 },
    });
  });

  it('refuses a plan with an index its count does not give', async () => {
    const config = reads(2);
    const saved = await newOrchestrator().plan(config);
    const extra = { ...saved, dataSources: { ...saved.dataSources, 'data.local_file.f[2]': saved.dataSources['data.local_file.f[1]'] } };

    await expect(run(extra, config)).rejects.toThrow('The plan has "data.local_file.f[2]", which the configuration does not declare');
  });

  // In a module that makes no instance, so only the read as written reaches the count.
  it('refuses a broken count at validate in a module called with count = 0', async () => {
    await fs.mkdir(path.join(dir, 'm'));
    await fs.writeFile(path.join(dir, 'm', 'main.clay'), 'data "local_file" "f" {\n  count = length(tolist([1, true]))\n  path  = "x"\n}', 'utf8');

    await expect(newOrchestrator().validate('module "m" {\n  count  = 0\n  source = "./m"\n}')).rejects.toMatchObject({
      message: 'tolist cannot join a number and a boolean into one type',
      block: 'data "local_file" "f"',
      position: { file: path.join('m', 'main.clay'), line: 2, column: 25 },
    });
  });
});
