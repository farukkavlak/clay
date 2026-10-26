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

describe('a data source with for_each', () => {
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

  // Reads zero.txt under "a" and one.txt under "b".
  const reads = (forEach = '{ a = "zero", b = "one" }') => `data "local_file" "f" {\n  for_each = ${forEach}\n  path     = "${dir}/\${each.value}.txt"\n}\n`;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-data-for-each-'));
    await fs.writeFile(path.join(dir, 'zero.txt'), 'zero', 'utf8');
    await fs.writeFile(path.join(dir, 'one.txt'), 'one', 'utf8');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('reads one instance for each key, each read by its key', async () => {
    const config = `${reads()}output "b" { value = data.local_file.f["b"].content }\noutput "all" { value = { for k, f in data.local_file.f : k => f.content } }`;

    const outputs = await apply(config);

    expect(outputs).toEqual({ b: 'one', all: { a: 'zero', b: 'one' } });
  });

  it('reads every instance, named alone, as a map by key', async () => {
    const config = `${reads()}output "whole" { value = data.local_file.f }`;

    const { outputs } = await newOrchestrator().plan(config);

    expect(outputs.whole.new?.value).toEqual({ a: { path: `${dir}/zero.txt`, content: 'zero' }, b: { path: `${dir}/one.txt`, content: 'one' } });
    expect(outputs.whole.new?.type).toEqual(types.map(types.object({ path: types.string, content: types.string })));
  });

  it('takes a list of strings, each the key and the value', async () => {
    const config = `${reads('["zero", "one"]')}output "all" { value = { for k, f in data.local_file.f : k => f.content } }`;

    const outputs = await apply(config);

    expect(outputs).toEqual({ all: { zero: 'zero', one: 'one' } });
  });

  it('reads nothing with an empty for_each', async () => {
    const config = `${reads('{}')}output "whole" { value = data.local_file.f }`;

    const plan = await newOrchestrator().plan(config);

    expect(plan.outputs.whole.new?.value).toEqual({});
    expect(plan.dataSources).toEqual({});
  });

  it('types every instance as a map where it is read as written', async () => {
    const config = `${reads()}resource "local_file" "copy" {\n  count   = 0\n  path    = "copy.txt"\n  content = data.local_file.f\n}`;

    await expect(newOrchestrator().validate(config)).rejects.toMatchObject({
      message: 'content is a map, where local_file takes a string',
      position: { file: CONFIG_FILE, line: 8, column: 13 },
    });
  });

  it('names each instance by its key in the plan, and runs from the plan file', async () => {
    const config = `${reads()}output "b" { value = data.local_file.f["b"].content }`;

    const saved = parsePlanFile(serializePlan(await newOrchestrator().plan(config), config, {}), 'plan.json');

    expect(Object.keys(saved.dataSources)).toEqual(['data.local_file.f["a"]', 'data.local_file.f["b"]']);
    expect(await run(saved, config)).toEqual({ b: 'one' });
  });

  it('is read for each key in each instance of its module', async () => {
    await fs.mkdir(path.join(dir, 'm'));
    await fs.writeFile(path.join(dir, 'm', 'main.clay'), `${reads()}output "b" { value = data.local_file.f["b"].content }`, 'utf8');
    const config = 'module "m" {\n  for_each = ["x", "y"]\n  source   = "./m"\n}\noutput "all" { value = { for k, m in module.m : k => m.b } }';

    const plan = await newOrchestrator().plan(config);

    expect(Object.keys(plan.dataSources)).toEqual([
      'module.m["x"].data.local_file.f["a"]',
      'module.m["x"].data.local_file.f["b"]',
      'module.m["y"].data.local_file.f["a"]',
      'module.m["y"].data.local_file.f["b"]',
    ]);
    expect(plan.outputs.all.new?.value).toEqual({ x: 'one', y: 'one' });
  });

  it('waits for the apply at each key when what it reads changes, and reads each by its own value', async () => {
    // Empty, so the path is zero.txt and one.txt, read only once it is made.
    const marker = `resource "local_file" "marker" {\n  path    = "${dir}/marker.txt"\n  content = ""\n}\n`;
    const config = `${marker}data "local_file" "f" {\n  for_each = { a = "zero", b = "one" }\n  path     = "${dir}/\${each.value}.txt\${local_file.marker.content}"\n}\noutput "all" { value = { for k, f in data.local_file.f : k => f.content } }`;

    const plan = await newOrchestrator().plan(config);

    expect(plan.readAtApply).toEqual(['data.local_file.f["a"]', 'data.local_file.f["b"]']);
    expect(await run(plan, config)).toEqual({ all: { a: 'zero', b: 'one' } });
  });

  it('waits for the apply at each key when its for_each reads a resource the plan changes', async () => {
    const made = `resource "local_file" "m" {\n  path    = "${dir}/m.txt"\n  content = "zero"\n}\n`;
    const config = `${made}${reads('{ a = local_file.m.content, b = "one" }')}output "all" { value = { for k, f in data.local_file.f : k => f.content } }`;

    const plan = await newOrchestrator().plan(config);

    expect(plan.readAtApply).toEqual(['data.local_file.f["a"]', 'data.local_file.f["b"]']);
    expect(await run(plan, config)).toEqual({ all: { a: 'zero', b: 'one' } });
  });

  it.each([
    ['an undeclared variable', 'var.missing', 'var.missing', 'variable "missing" is not defined'],
    ['a number', '3', '3', 'for_each is a map, or a list or a set of strings, not a number'],
  ])('refuses a for_each that reads %s, at the value', async (_, forEach, refused, message) => {
    const config = reads(forEach);

    await expect(newOrchestrator().plan(config)).rejects.toMatchObject({
      message,
      block: 'data "local_file" "f"',
      position: { file: CONFIG_FILE, line: 2, column: 14 + forEach.indexOf(refused) },
    });
  });

  it('refuses count.index in a data source with for_each', async () => {
    const config = `data "local_file" "f" {\n  for_each = ["zero"]\n  path     = "\${count.index}.txt"\n}`;

    await expect(newOrchestrator().plan(config)).rejects.toMatchObject({
      message: 'count.index is only known inside a resource, a data source or a module call that has count',
      position: { file: CONFIG_FILE, line: 3, column: 17 },
    });
  });

  it('refuses a plan with no value for a key its for_each gives', async () => {
    const config = reads();
    const saved = await newOrchestrator().plan(config);
    const { 'data.local_file.f["b"]': _dropped, ...kept } = saved.dataSources;

    await expect(run({ ...saved, dataSources: kept }, config)).rejects.toMatchObject({
      message: 'The plan has no value for data.local_file.f["b"], which the configuration declares',
      block: 'data "local_file" "f"',
    });
  });

  it.each([
    ['a key its for_each does not give', 'data.local_file.f["c"].content', 'data.local_file.f has no instance ["c"], only ["a"], ["b"]'],
    ['an index', 'data.local_file.f[0].content', 'data.local_file.f has for_each, so name one of it by key, as in data.local_file.f["key"]'],
    ['no key', 'data.local_file.f.content', 'data.local_file.f has for_each, so name one of it by key, as in data.local_file.f["key"]'],
  ])('refuses %s', async (_, read, message) => {
    const config = `${reads()}output "o" { value = ${read} }`;

    await expect(newOrchestrator().plan(config)).rejects.toMatchObject({ message, position: { file: CONFIG_FILE, line: 5, column: 22 } });
  });

  it.each(['key', 'value'])('refuses each.%s in a data source with no for_each', async (name) => {
    const config = `data "local_file" "f" { path = "\${each.${name}}.txt" }`;

    await expect(newOrchestrator().plan(config)).rejects.toMatchObject({
      message: `each.${name} is only known inside a resource, a data source or a module call that has for_each`,
      block: 'data "local_file" "f"',
      position: { file: CONFIG_FILE, line: 1, column: 35 },
    });
  });

  it('refuses a for_each not known when planning', async () => {
    const writes = `resource "local_file" "a" {\n  path    = "${dir}/a.txt"\n  content = "made"\n}\ndata "local_file" "read" { path = local_file.a.path }\n`;
    const config = `${writes}${reads('toset([data.local_file.read.content])')}`;

    await expect(newOrchestrator().plan(config)).rejects.toMatchObject({
      message: 'for_each must be known when planning: a member reads a value only an apply makes, and a set names its instances by its members',
      block: 'data "local_file" "f"',
      position: { file: CONFIG_FILE, line: 7, column: 14 },
    });
  });

  it('refuses a plan with a key its for_each does not give', async () => {
    const config = reads();
    const saved = await newOrchestrator().plan(config);
    const extra = { ...saved, dataSources: { ...saved.dataSources, 'data.local_file.f["c"]': saved.dataSources['data.local_file.f["b"]'] } };

    await expect(run(extra, config)).rejects.toThrow('The plan has "data.local_file.f["c"]", which the configuration does not declare');
  });

  // In a module that makes no instance, so only the read as written reaches the for_each.
  it('refuses a broken for_each at validate in a module called with count = 0', async () => {
    await fs.mkdir(path.join(dir, 'm'));
    await fs.writeFile(path.join(dir, 'm', 'main.clay'), 'data "local_file" "f" {\n  for_each = toset(tolist([1, true]))\n  path     = "x"\n}', 'utf8');

    await expect(newOrchestrator().validate('module "m" {\n  count  = 0\n  source = "./m"\n}')).rejects.toMatchObject({
      message: 'tolist cannot join a number and a boolean into one type',
      block: 'data "local_file" "f"',
      position: { file: path.join('m', 'main.clay'), line: 2, column: 27 },
    });
  });
});
