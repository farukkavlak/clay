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

const counted = (count: number) => `
  module "site" {
    count  = ${count}
    source = "./site"
    name   = "site-\${count.index}"
  }
  output "sites" { value = [for site in module.site : site.read] }
`;

// Only a data source, so a plan that does not match is refused at it and not at a resource before it.
const READER = 'variable "path" {}\ndata "local_file" "read" { path = var.path }';

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

  const readers = (count: number) => `${writes('new')}\nmodule "reader" {\n  count = ${count}\n  source = "./reader"\n  path = local_file.a.path\n}`;

  // The module passes the path on, so the data source reaches the resource only through an output.
  const readsThroughModule = async (content: string) => {
    await fs.mkdir(path.join(dir, 'm'), { recursive: true });
    await fs.writeFile(path.join(dir, 'm', 'main.clay'), `${writes(content)}\noutput "path" { value = local_file.a.path }`, 'utf8');

    return 'module "m" { source = "./m" }\ndata "local_file" "read" { path = module.m.path }\noutput "read" { value = data.local_file.read.content }';
  };

  // An absolute path, since the provider reads a relative one from where the test runs.
  const site = () => `
    variable "name" {}
    resource "local_file" "page" {
      path    = "${dir}/\${var.name}.txt"
      content = "body of \${var.name}"
    }
    data "local_file" "read" { path = local_file.page.path }
    output "read" { value = data.local_file.read.content }
  `;

  const writeModule = async (name: string, content: string) => {
    await fs.mkdir(path.join(dir, name), { recursive: true });
    await fs.writeFile(path.join(dir, name, 'main.clay'), content, 'utf8');
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

  it.each([
    ['left for the apply', false],
    ['read at plan', true],
  ])('refuses a plan with a data source %s that the configuration does not declare, before anything runs', async (_, applied) => {
    // No output, so the plan is refused at the data source and not at an output before it.
    const reads = (content: string) => `${writes(content)}\ndata "local_file" "read" { path = local_file.a.path }`;
    if (applied) await apply(reads('old'));
    const saved = await newOrchestrator().plan(reads(applied ? 'old' : 'new'));

    await expect(run(saved, writes('newer'))).rejects.toThrow('The plan has "data.local_file.read", which the configuration does not declare');
    expect(await fs.readFile(file, 'utf8').catch(() => 'no file')).toBe(applied ? 'old' : 'no file');
  });

  it('refuses a plan that names a data source in a way no address is written', async () => {
    const saved = await newOrchestrator().plan(writes('new'));

    await expect(run({ ...saved, readAtApply: ['data.local_file'] }, writes('new'))).rejects.toThrow(
      'Invalid address "data.local_file": a data source is named data, its type and its name'
    );
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

  it('reads as a whole what it was given as known and the rest as known after apply while it waits for the apply', async () => {
    const config = `${writesAndReads('new')}\noutput "whole" { value = data.local_file.read }`;

    const { outputs } = await newOrchestrator().plan(config);

    expect(outputs.whole.new?.value).toEqual({ path: file, content: UNKNOWN });
  });

  it('refuses a count that reads it while it waits for the apply', async () => {
    const config = `${writesAndReads('new')}\nresource "null_resource" "n" {\n  count = length(data.local_file.read.content)\n}`;

    await expect(newOrchestrator().plan(config)).rejects.toMatchObject({
      message: 'count must be known when planning: it reads a value only an apply makes',
      block: 'resource "null_resource" "n"',
      position: { line: 12, column: 11 },
    });
  });

  it('refuses at plan what its provider will not take, though it waits for the apply', async () => {
    const config = `${writes('')}\ndata "local_file" "read" { path = local_file.a.content }`;

    await expect(newOrchestrator().plan(config)).rejects.toMatchObject({
      message: 'local_file "path" must not be empty',
      block: 'data "local_file" "read"',
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

  describe('in a module with instances', () => {
    beforeEach(async () => {
      await writeModule('site', site());
    });

    it('is read once for each instance of a module called with count', async () => {
      const outputs = await apply(counted(2));

      expect(outputs.sites).toEqual(['body of site-0', 'body of site-1']);
    });

    it('is read once for each instance of a module called with for_each', async () => {
      const config = `
        module "site" {
          for_each = ["ali", "veli"]
          source   = "./site"
          name     = each.key
        }
        output "ali" { value = module.site["ali"].read }
        output "veli" { value = module.site["veli"].read }
      `;

      const outputs = await apply(config);

      expect(outputs).toEqual({ ali: 'body of ali', veli: 'body of veli' });
    });

    it('is read once for each instance of a module inside a module with instances', async () => {
      await writeModule('outer/site', site());
      await writeModule(
        'outer',
        `
          variable "prefix" {}
          module "site" {
            for_each = ["a", "b"]
            source   = "./site"
            name     = "\${var.prefix}-\${each.key}"
          }
          output "a" { value = module.site["a"].read }
          output "b" { value = module.site["b"].read }
        `
      );
      const config = `
        module "outer" {
          count  = 2
          source = "./outer"
          prefix = "outer-\${count.index}"
        }
        output "read" { value = [for outer in module.outer : "\${outer.a} and \${outer.b}"] }
      `;

      const plan = await newOrchestrator().plan(config);
      const outputs = await run(plan, config);

      expect(plan.readAtApply).toEqual([
        'module.outer[0].module.site["a"].data.local_file.read',
        'module.outer[0].module.site["b"].data.local_file.read',
        'module.outer[1].module.site["a"].data.local_file.read',
        'module.outer[1].module.site["b"].data.local_file.read',
      ]);
      expect(outputs.read).toEqual(['body of outer-0-a and body of outer-0-b', 'body of outer-1-a and body of outer-1-b']);
    });

    it('waits for the apply only in the instance whose resource changes', async () => {
      await apply(counted(1));

      const plan = await newOrchestrator().plan(counted(2));
      const outputs = await run(plan, counted(2));

      expect(plan.readAtApply).toEqual(['module.site[1].data.local_file.read']);
      expect(plan.dataSources['module.site[0].data.local_file.read'].content.value).toBe('body of site-0');
      expect(outputs.sites).toEqual(['body of site-0', 'body of site-1']);
    });

    it('gives each instance its own value from a plan saved to a file', async () => {
      await apply(counted(1));
      const saved = parsePlanFile(serializePlan(await newOrchestrator().plan(counted(2)), counted(2), {}), 'plan.json');

      const outputs = await run(saved, counted(2));

      expect(Object.keys(saved.dataSources)).toEqual(['module.site[0].data.local_file.read']);
      expect(outputs.sites).toEqual(['body of site-0', 'body of site-1']);
    });

    it('names the instance in the plan and in the apply', async () => {
      await fs.writeFile(path.join(dir, 'main.clay'), counted(2), 'utf8');

      const planned = await clayIn('plan');
      const applied = await clayIn('apply', '--yes');

      expect(planned).toContain('  <= module.site[0].data.local_file.read will be read during apply\n  <= module.site[1].data.local_file.read will be read during apply\n');
      expect(applied.match(/^ {2}<= .* read$/gm)).toEqual(['  <= module.site[0].data.local_file.read read', '  <= module.site[1].data.local_file.read read']);
    });

    it('refuses a plan with no value for an instance the configuration makes', async () => {
      await writeModule('reader', READER);
      const saved = await newOrchestrator().plan(readers(1));

      await expect(run(saved, readers(2))).rejects.toMatchObject({
        message: 'The plan has no value for module.reader[1].data.local_file.read, which the configuration declares',
        block: 'data "local_file" "read"',
        module: 'module.reader[1]',
      });
    });

    it.each([
      ['left for the apply', false],
      ['read at plan', true],
    ])('refuses a plan with a data source %s in an instance the configuration does not make', async (_, applied) => {
      await writeModule('reader', READER);
      if (applied) await apply(readers(2));
      const saved = await newOrchestrator().plan(readers(2));

      await expect(run(saved, readers(1))).rejects.toThrow('The plan has "module.reader[1].data.local_file.read", which the configuration does not declare');
      expect(applied ? Object.keys(saved.dataSources) : saved.readAtApply).toContain('module.reader[1].data.local_file.read');
    });

    it('names the instance whose read fails', async () => {
      await writeModule('site', site().replace('local_file.page.path }', '"${local_file.page.path}-missing" }'));

      await expect(apply(counted(2))).rejects.toMatchObject({
        message: `local_file cannot read "${path.join(dir, 'site-0.txt')}-missing": there is no such file`,
        block: 'data "local_file" "read"',
        module: 'module.site[0]',
      });
    });
  });
});
