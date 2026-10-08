import { UNKNOWN } from '@clay/contracts';
import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { parsePlanFile, Plan, serializePlan } from '@clay/planner';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// The tests compile to CommonJS, which has no import.meta.dirname.
// eslint-disable-next-line unicorn/prefer-module
const clay = path.resolve(__dirname, '../../bin/clay.js');

describe('a data source in the graph', () => {
  let dir: string;
  let file: string;

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

  const clayIn = async (...args: string[]) => {
    const { stdout } = await promisify(execFile)('node', [clay, ...args], { cwd: dir });
    return stripVTControlCharacters(stdout);
  };

  const writes = (content: string) => `
    resource "local_file" "a" {
      path    = "${file}"
      content = "${content}"
    }
  `;

  const writesAndReads = (content: string) => `
    ${writes(content)}
    data "local_file" "read" { path = local_file.a.path }
    output "read" { value = data.local_file.read.content }
  `;

  // The module passes the path on, so the data source reaches the resource only through an output.
  const readsThroughModule = async (content: string) => {
    await fs.mkdir(path.join(dir, 'm'), { recursive: true });
    await fs.writeFile(path.join(dir, 'm', 'main.clay'), `${writes(content)}\noutput "path" { value = local_file.a.path }`, 'utf8');

    return 'module "m" { source = "./m" }\ndata "local_file" "read" { path = module.m.path }\noutput "read" { value = data.local_file.read.content }';
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-data-node-'));
    file = path.join(dir, 'a.txt');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('reads a file the same apply creates', async () => {
    const outputs = await apply(writesAndReads('new'));

    expect(outputs.read).toBe('new');
  });

  it('reads a file after the resource that changes it, not what it held before', async () => {
    await apply(writes('old'));

    const outputs = await apply(writesAndReads('new'));

    expect(outputs.read).toBe('new');
  });

  it('is read at plan when nothing it reads changes', async () => {
    await apply(writesAndReads('same'));

    const plan = await newOrchestrator().plan(writesAndReads('same'));

    expect(plan.readAtApply).toEqual([]);
    expect(plan.dataSources['data.local_file.read'].content.value).toBe('same');
  });

  it('waits for a resource it reads through a module output', async () => {
    await apply(await readsThroughModule('old'));
    const config = await readsThroughModule('new');

    const plan = await newOrchestrator().plan(config);
    const outputs = await run(plan, config);

    expect(plan.readAtApply).toEqual(['data.local_file.read']);
    expect(outputs.read).toBe('new');
  });

  it('is read at apply from a plan saved to a file', async () => {
    const config = writesAndReads('new');
    const saved = parsePlanFile(serializePlan(await newOrchestrator().plan(config), config, {}), 'plan.json');

    const outputs = await run(saved, config);

    expect(saved.readAtApply).toEqual(['data.local_file.read']);
    expect(outputs.read).toBe('new');
  });

  it('refuses a plan that neither read a data source nor left it for the apply', async () => {
    const config = writesAndReads('new');
    const saved = await newOrchestrator().plan(config);

    await expect(run({ ...saved, readAtApply: [] }, config)).rejects.toMatchObject({
      message: 'The plan has no value for data.local_file.read, which the configuration declares',
      block: 'data "local_file" "read"',
    });
    expect(await fs.readFile(file, 'utf8')).toBe('new');
  });

  it('says in the plan and in the apply that it reads during apply', async () => {
    await fs.writeFile(path.join(dir, 'main.clay'), writesAndReads('new'), 'utf8');

    const planned = await clayIn('plan');
    const applied = await clayIn('apply', '--yes');

    expect(planned).toContain('  + local_file.a will be created\n  <= data.local_file.read will be read during apply\n');
    expect(planned).toContain('Plan: 1 to add, 0 to change, 0 to destroy.');
    expect(applied).toContain('  + local_file.a created\n  <= data.local_file.read read\n');
  });

  it('stands beside a resource of the same type and name', async () => {
    const config = `${writes('both')}\ndata "local_file" "a" { path = local_file.a.path }\noutput "read" { value = data.local_file.a.content }`;

    const outputs = await apply(config);

    expect(outputs.read).toBe('both');
  });

  it('names itself by its address in a cycle', async () => {
    const config = `resource "local_file" "a" {\n  path    = "${file}"\n  content = data.local_file.read.content\n}\ndata "local_file" "read" { path = local_file.a.path }`;

    await expect(newOrchestrator().plan(config)).rejects.toThrow(/^Dependency cycle detected: .*data\.local_file\.read/);
  });

  it('keeps what it was given known while it waits for the apply', async () => {
    const config = `${writesAndReads('new')}\noutput "from" { value = data.local_file.read.path }`;

    const { outputs } = await newOrchestrator().plan(config);

    expect(outputs.from.new?.value).toBe(file);
    expect(outputs.read.new?.value).toBe(UNKNOWN);
  });

  it('refuses a count that reads it while it waits for the apply', async () => {
    const config = `${writesAndReads('new')}\nresource "null_resource" "n" {\n  count = length(data.local_file.read.content)\n}`;

    await expect(newOrchestrator().plan(config)).rejects.toMatchObject({
      message: 'count must be known when planning: it reads a value only an apply makes',
      block: 'resource "null_resource" "n"',
      position: { line: 12, column: 11 },
    });
  });

  it('stops the apply at a read that fails, keeping what was made before it', async () => {
    const config = `${writes('new')}\ndata "local_file" "read" { path = "\${local_file.a.path}-missing" }`;

    await expect(apply(config)).rejects.toMatchObject({
      message: `local_file cannot read "${file}-missing": there is no such file`,
      block: 'data "local_file" "read"',
    });
    const state = await new LocalBackend(dir).read();
    expect(Object.keys(state.resources)).toEqual(['local_file.a']);
  });
});
