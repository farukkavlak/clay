import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { isUnknown } from '@clay/planner';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { start } from './start';

// The CLI reads process.cwd() and parses on import, so these tests drive the orchestrator instead.
describe('apply and plan against real files', () => {
  let dir: string;
  let orchestrator: Orchestrator;

  const newOrchestrator = () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    return engine;
  };

  const fileConfig = (content: string) => `
    resource "local_file" "a" {
      path = "${path.join(dir, 'a.txt')}"
      content = "${content}"
    }
  `;

  const chained = (content: string) => `
    resource "local_file" "a" {
      path = "${path.join(dir, 'a.txt')}"
      content = "${content}"
    }
    resource "local_file" "b" {
      path = "${path.join(dir, 'b.txt')}"
      content = "\${local_file.a.content}"
    }
  `;

  const apply = async (engine: Orchestrator, config: string) => {
    let outputs: Record<string, unknown> = {};
    for await (const event of start(engine, config)) {
      if (event.type === 'failed') throw event.error;
      if (event.type === 'done') outputs = event.outputs;
    }
    return outputs;
  };

  const changes = async (config: string) => {
    const { actions } = await newOrchestrator().plan(config);
    return actions.filter((action) => action.type !== 'NO_OP');
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-e2e-'));
    orchestrator = newOrchestrator();
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('creates the file and records it in state', async () => {
    await apply(orchestrator, fileConfig('hello'));

    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('hello');
    const state = await new LocalBackend(dir).read();
    expect(Object.keys(state.resources)).toEqual(['local_file.a']);
  });

  it('plans a create before the first apply', async () => {
    const actions = await changes(fileConfig('hello'));

    expect(actions.map((action) => action.type)).toEqual(['CREATE']);
  });

  it('plans no changes right after an apply', async () => {
    await apply(orchestrator, fileConfig('hello'));

    expect(await changes(fileConfig('hello'))).toEqual([]);
  });

  it('plans no changes when the config uses a variable', async () => {
    const config = `
      variable "greeting" { default = "Hello" }
      resource "local_file" "a" {
        path = "${path.join(dir, 'a.txt')}"
        content = "\${var.greeting} Clay!"
      }
    `;
    await apply(orchestrator, config);

    expect(await changes(config)).toEqual([]);
  });

  it('plans a create when one resource reads a value the other has not produced yet', async () => {
    const config = `
      resource "local_file" "a" {
        path = "${path.join(dir, 'a.txt')}"
        content = "hello"
      }
      resource "local_file" "b" {
        path = "${path.join(dir, 'b.txt')}"
        content = "\${local_file.a.id}"
      }
    `;

    const actions = await changes(config);

    expect(actions.map((action) => action.type)).toEqual(['CREATE', 'CREATE']);
  });

  it('plans, instead of failing, when a reference reads an attribute the state does not have yet', async () => {
    const withMode = `
      resource "local_file" "a" {
        path = "${path.join(dir, 'a.txt')}"
        content = "hello"
        mode = "0644"
      }
      resource "local_file" "b" {
        path = "${path.join(dir, 'b.txt')}"
        content = "\${local_file.a.mode}"
      }
    `;
    await apply(orchestrator, fileConfig('hello'));

    const actions = await changes(withMode);

    expect(actions.map((action) => action.type)).toEqual(['UPDATE', 'CREATE']);
  });

  it('plans an update, not a replacement, when only the content changes', async () => {
    await apply(orchestrator, fileConfig('hello'));

    const actions = await changes(fileConfig('bye'));

    expect(actions.map((action) => action.type)).toEqual(['UPDATE']);
    expect(actions[0].changes).toEqual({ content: { old: 'hello', new: 'bye' } });
  });

  it('plans an update for a resource that reads a value changing in the same run', async () => {
    await apply(orchestrator, chained('one'));

    const actions = await changes(chained('two'));

    expect(actions.map((action) => [action.name, action.type])).toEqual([
      ['a', 'UPDATE'],
      ['b', 'UPDATE'],
    ]);
    expect(isUnknown(actions[1].changes!.content.new)).toBe(true);
  });

  it('writes the new value through to the resource that reads it', async () => {
    await apply(orchestrator, chained('one'));

    await apply(newOrchestrator(), chained('two'));

    expect(await fs.readFile(path.join(dir, 'b.txt'), 'utf8')).toBe('two');
  });

  it('rejects a reference to a resource the config does not declare', async () => {
    const config = `
      resource "local_file" "a" {
        path = "${path.join(dir, 'a.txt')}"
        content = "\${local_file.typo.content}"
      }
    `;

    await expect(newOrchestrator().plan(config)).rejects.toThrow('"local_file.typo" is not declared in the configuration');
  });

  it('names the resources in a dependency cycle', async () => {
    const config = `
      resource "local_file" "a" {
        path = "${path.join(dir, 'a.txt')}"
        content = "\${local_file.b.content}"
      }
      resource "local_file" "b" {
        path = "${path.join(dir, 'b.txt')}"
        content = "\${local_file.a.content}"
      }
    `;

    await expect(newOrchestrator().plan(config)).rejects.toThrow('Dependency cycle detected: local_file.a -> local_file.b -> local_file.a');
  });

  it('plans an update through a module output when the resource behind it changes', async () => {
    const moduleConfig = `
      resource "local_file" "inner" {
        path = "${path.join(dir, 'inner.txt')}"
        content = "\${var.text}"
      }
      output "text" { value = "\${local_file.inner.content}" }
    `;
    const rootConfig = (text: string) => `
      module "m" {
        source = "./m"
        text = "${text}"
      }
      resource "local_file" "c" {
        path = "${path.join(dir, 'c.txt')}"
        content = "\${module.m.text}"
      }
    `;
    await fs.mkdir(path.join(dir, 'm'));
    await fs.writeFile(path.join(dir, 'm', 'main.clay'), moduleConfig);
    await apply(orchestrator, rootConfig('one'));

    const actions = await changes(rootConfig('two'));
    expect(actions.map((action) => action.name)).toEqual(['inner', 'c']);
    expect(isUnknown(actions[1].changes!.content.new)).toBe(true);

    await apply(newOrchestrator(), rootConfig('two'));

    expect(await fs.readFile(path.join(dir, 'c.txt'), 'utf8')).toBe('two');
    expect(await changes(rootConfig('two'))).toEqual([]);
  });

  it('plans no changes when a resource reads a module output', async () => {
    await fs.mkdir(path.join(dir, 'm'));
    await fs.writeFile(path.join(dir, 'm', 'main.clay'), 'output "name" { value = "produced" }');
    const config = `
      module "m" { source = "./m" }
      resource "local_file" "c" {
        path = "${path.join(dir, 'c.txt')}"
        content = "\${module.m.name}"
      }
    `;
    await apply(orchestrator, config);

    expect(await changes(config)).toEqual([]);
  });

  const throughModule = (content: string) => `
    resource "local_file" "a" {
      path = "${path.join(dir, 'a.txt')}"
      content = "${content}"
    }
    module "m" {
      source = "./m"
      text = "\${local_file.a.content}"
    }
  `;

  const writeModule = async () =>
    fs.writeFile(path.join(dir, 'm', 'main.clay'), `resource "local_file" "inner" { path = "${path.join(dir, 'inner.txt')}" content = "\${var.text}" }`);

  it('applies a module that reads a resource through its input', async () => {
    await fs.mkdir(path.join(dir, 'm'));
    await writeModule();

    await apply(orchestrator, throughModule('one'));

    expect(await fs.readFile(path.join(dir, 'inner.txt'), 'utf8')).toBe('one');
  });

  it('plans and applies a change that reaches a module through its input', async () => {
    await fs.mkdir(path.join(dir, 'm'));
    await writeModule();
    await apply(orchestrator, throughModule('one'));

    const actions = await changes(throughModule('two'));
    expect(actions.map((action) => action.name)).toEqual(['a', 'inner']);

    await apply(newOrchestrator(), throughModule('two'));

    expect(await fs.readFile(path.join(dir, 'inner.txt'), 'utf8')).toBe('two');
    expect(await changes(throughModule('two'))).toEqual([]);
  });

  it('names the variable that is not defined', async () => {
    const config = `
      resource "local_file" "a" {
        path = "${path.join(dir, 'a.txt')}"
        content = "\${var.missing}"
      }
    `;

    await expect(newOrchestrator().plan(config)).rejects.toThrow('variable "missing" is not defined');
  });

  it('plans no changes for a module named after a graph node kind', async () => {
    await fs.mkdir(path.join(dir, 'vars'));
    await fs.writeFile(path.join(dir, 'vars', 'main.clay'), 'output "o" { value = "inner" }');
    const config = `
      module "vars" { source = "./vars" }
      resource "local_file" "b" {
        path = "${path.join(dir, 'b.txt')}"
        content = "\${module.vars.o}"
      }
    `;
    await apply(orchestrator, config);

    expect(await changes(config)).toEqual([]);
  });

  it('resolves a variable default that reads a resource', async () => {
    const config = `
      variable "id" { default = "\${local_file.a.id}" }
      resource "local_file" "a" {
        path = "${path.join(dir, 'a.txt')}"
        content = "hello"
      }
      resource "local_file" "b" {
        path = "${path.join(dir, 'b.txt')}"
        content = "\${var.id}"
      }
    `;

    await apply(orchestrator, config);

    expect(await fs.readFile(path.join(dir, 'b.txt'), 'utf8')).toBe(path.join(dir, 'a.txt'));
    expect(await changes(config)).toEqual([]);
  });

  it('writes resolved values, not syntax, into the state outputs', async () => {
    const config = `
      variable "greeting" { default = "hello" }
      module "m" {
        source = "./m"
        text = "\${var.greeting}"
      }
      output "echo" { value = "\${module.m.echo}" }
    `;
    await fs.mkdir(path.join(dir, 'm'));
    await fs.writeFile(path.join(dir, 'm', 'main.clay'), `output "echo" { value = "\${var.text}" }`);

    await apply(orchestrator, config);

    const state = await new LocalBackend(dir).read();
    expect(state.outputs).toEqual({ echo: 'hello' });
  });

  it('says that modules are read through their outputs', async () => {
    await fs.mkdir(path.join(dir, 'm'));
    await fs.writeFile(path.join(dir, 'm', 'main.clay'), `resource "local_file" "inner" { path = "${path.join(dir, 'inner.txt')}" content = "x" }`);
    const config = `
      module "m" { source = "./m" }
      resource "local_file" "c" {
        path = "${path.join(dir, 'c.txt')}"
        content = "\${module.m.local_file.inner.content}"
      }
    `;

    await expect(newOrchestrator().plan(config)).rejects.toThrow('modules are read through their outputs');
  });

  it('plans one replacement when a forceNew attribute changes', async () => {
    await apply(orchestrator, fileConfig('hello'));
    const moved = fileConfig('hello').replace('a.txt', 'moved.txt');

    const actions = await changes(moved);

    expect(actions.map((action) => action.type)).toEqual(['REPLACE']);
  });

  it('keeps a replaced resource in state and settles on the next plan', async () => {
    await apply(orchestrator, fileConfig('hello'));
    const moved = fileConfig('hello').replace('a.txt', 'moved.txt');

    await apply(newOrchestrator(), moved);

    const files = await fs.readdir(dir);
    expect(files.filter((name) => name.endsWith('.txt'))).toEqual(['moved.txt']);
    const state = await new LocalBackend(dir).read();
    expect(state.resources['local_file.a'].id).toBe(path.join(dir, 'moved.txt'));
    expect(await changes(moved)).toEqual([]);
  });

  it('drops an attribute from state when the config drops it', async () => {
    const withMode = fileConfig('hello').replace('content = "hello"', 'content = "hello"\n      mode = "0644"');
    await apply(orchestrator, withMode);

    const actions = await changes(fileConfig('hello'));
    expect(actions[0].changes).toEqual({ mode: { old: '0644', new: undefined } });

    await apply(newOrchestrator(), fileConfig('hello'));

    const state = await new LocalBackend(dir).read();
    expect(state.resources['local_file.a'].attributes).not.toHaveProperty('mode');
    expect(await changes(fileConfig('hello'))).toEqual([]);
  });

  const destroyedNames = async (config: string) => {
    const names: string[] = [];
    for await (const event of start(newOrchestrator(), config)) {
      if (event.type === 'failed') throw event.error;
      if (event.type === 'applied' && event.action.type === 'DELETE') names.push(event.action.name);
    }
    return names;
  };

  it('writes down what each resource reads from', async () => {
    await apply(orchestrator, chained('hello'));

    const state = await new LocalBackend(dir).read();
    expect(state.resources['local_file.b'].dependencies).toEqual(['local_file.a']);
    expect(state.resources['local_file.a'].dependencies).toEqual([]);
  });

  it('deletes a removed resource before the one it read from', async () => {
    await apply(orchestrator, chained('hello'));

    expect(await destroyedNames('')).toEqual(['b', 'a']);
  });

  it('deletes the resources of a removed module in reverse dependency order', async () => {
    const moduleConfig = `
      resource "local_file" "inner_a" {
        path = "${path.join(dir, 'inner-a.txt')}"
        content = "hello"
      }
      resource "local_file" "inner_b" {
        path = "${path.join(dir, 'inner-b.txt')}"
        content = "\${local_file.inner_a.content}"
      }
    `;
    await fs.mkdir(path.join(dir, 'm'));
    await fs.writeFile(path.join(dir, 'm', 'main.clay'), moduleConfig);
    await apply(orchestrator, 'module "m" { source = "./m" }');

    expect(await destroyedNames('')).toEqual(['inner_b', 'inner_a']);
  });

  it('writes down a new dependency even when no value changes', async () => {
    const viaVariable = chained('hello').replace(`"\${local_file.a.content}"`, `"\${var.text}"`) + `\nvariable "text" { default = "hello" }`;
    await apply(orchestrator, viaVariable);
    const before = await new LocalBackend(dir).read();
    expect(before.resources['local_file.b'].dependencies).toEqual([]);

    await apply(newOrchestrator(), chained('hello'));

    const state = await new LocalBackend(dir).read();
    expect(state.resources['local_file.b'].dependencies).toEqual(['local_file.a']);
  });

  it('deletes a resource whose state predates dependencies', async () => {
    await apply(orchestrator, chained('hello'));
    const backend = new LocalBackend(dir);
    const state = await backend.read();
    for (const resource of Object.values(state.resources)) delete resource.dependencies;
    await backend.write(state);

    expect(await destroyedNames('')).toEqual(['a', 'b']);
  });

  // b's path sits under a file, so its create fails after a's has succeeded.
  const secondFails = () => `
    resource "local_file" "a" {
      path = "${path.join(dir, 'a.txt')}"
      content = "hello"
    }
    resource "local_file" "b" {
      path = "${path.join(dir, 'a.txt', 'b.txt')}"
      content = "hello"
    }
  `;

  it('keeps what a failed run managed to do', async () => {
    await expect(apply(orchestrator, secondFails())).rejects.toThrow();

    const state = await new LocalBackend(dir).read();
    expect(Object.keys(state.resources)).toEqual(['local_file.a']);
    const actions = await changes(secondFails());
    expect(actions.map((action) => action.name)).toEqual(['b']);
  });

  it('reports each step as it goes and stops at the one that fails', async () => {
    const events: string[] = [];
    for await (const event of start(orchestrator, secondFails()))
      events.push(event.type === 'planned' || event.type === 'done' ? event.type : `${event.type} ${event.action.name}`);

    expect(events).toEqual(['planned', 'started a', 'applied a', 'started b', 'failed b']);
  });

  const lockFile = () => path.join(dir, 'clay.state.json.lock');

  it('refuses a second run while one holds the state', async () => {
    const first = start(orchestrator, fileConfig('hello'));
    await first.next();

    await expect(apply(newOrchestrator(), fileConfig('hello'))).rejects.toThrow('locked by another run');

    await first.return(undefined);
  });

  it('releases the lock when a run finishes', async () => {
    await apply(orchestrator, fileConfig('hello'));

    await expect(fs.access(lockFile())).rejects.toThrow();
  });

  it('releases the lock when a run fails', async () => {
    await expect(apply(orchestrator, secondFails())).rejects.toThrow();

    await expect(fs.access(lockFile())).rejects.toThrow();
  });

  it('holds the lock while running and releases it when the caller stops reading', async () => {
    const run = start(orchestrator, fileConfig('hello'));
    await run.next();
    await expect(fs.access(lockFile())).resolves.toBeUndefined();

    await run.return(undefined);

    await expect(fs.access(lockFile())).rejects.toThrow();
  });
});
