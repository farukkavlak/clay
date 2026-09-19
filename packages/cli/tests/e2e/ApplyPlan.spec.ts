import { Orchestrator } from '@miniform/orchestrator';
import { isUnknown } from '@miniform/planner';
import { LocalProvider } from '@miniform/provider-local';
import { LocalBackend, StateManager } from '@miniform/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// CLI commands read process.cwd() and parse on import, so the tests drive the orchestrator.
describe('apply and plan against real files', () => {
  let dir: string;
  let orchestrator: Orchestrator;

  const newOrchestrator = () => {
    const engine = new Orchestrator(new StateManager(new LocalBackend(dir)));
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

  const changes = async (config: string) => {
    const actions = await newOrchestrator().plan(config, dir);
    return actions.filter((action) => action.type !== 'NO_OP');
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'miniform-e2e-'));
    orchestrator = newOrchestrator();
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('creates the file and records it in state', async () => {
    await orchestrator.apply(fileConfig('hello'), dir);

    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('hello');
    const state = await new LocalBackend(dir).read();
    expect(Object.keys(state.resources)).toEqual(['local_file.a']);
  });

  it('plans a create before the first apply', async () => {
    const actions = await changes(fileConfig('hello'));

    expect(actions.map((action) => action.type)).toEqual(['CREATE']);
  });

  it('plans no changes right after an apply', async () => {
    await orchestrator.apply(fileConfig('hello'), dir);

    expect(await changes(fileConfig('hello'))).toEqual([]);
  });

  it('plans no changes when the config uses a variable', async () => {
    const config = `
      variable "greeting" { default = "Hello" }
      resource "local_file" "a" {
        path = "${path.join(dir, 'a.txt')}"
        content = "\${var.greeting} Miniform!"
      }
    `;
    await orchestrator.apply(config, dir);

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
    await orchestrator.apply(fileConfig('hello'), dir);

    const actions = await changes(withMode);

    expect(actions.map((action) => action.type)).toEqual(['UPDATE', 'CREATE']);
  });

  it('plans an update, not a replacement, when only the content changes', async () => {
    await orchestrator.apply(fileConfig('hello'), dir);

    const actions = await changes(fileConfig('bye'));

    expect(actions.map((action) => action.type)).toEqual(['UPDATE']);
    expect(actions[0].changes).toEqual({ content: { old: 'hello', new: 'bye' } });
  });

  it('plans an update for a resource that reads a value changing in the same run', async () => {
    await orchestrator.apply(chained('one'), dir);

    const actions = await changes(chained('two'));

    expect(actions.map((action) => [action.name, action.type])).toEqual([
      ['a', 'UPDATE'],
      ['b', 'UPDATE'],
    ]);
    expect(isUnknown(actions[1].changes!.content.new)).toBe(true);
  });

  it('writes the new value through to the resource that reads it', async () => {
    await orchestrator.apply(chained('one'), dir);

    await newOrchestrator().apply(chained('two'), dir);

    expect(await fs.readFile(path.join(dir, 'b.txt'), 'utf8')).toBe('two');
  });

  it('rejects a reference to a resource the config does not declare', async () => {
    const config = `
      resource "local_file" "a" {
        path = "${path.join(dir, 'a.txt')}"
        content = "\${local_file.typo.content}"
      }
    `;

    await expect(newOrchestrator().plan(config, dir)).rejects.toThrow('"local_file.typo" is not declared in the configuration');
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

    await expect(newOrchestrator().plan(config, dir)).rejects.toThrow('Dependency cycle detected: local_file.a -> local_file.b -> local_file.a');
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
    await fs.writeFile(path.join(dir, 'm', 'main.mf'), moduleConfig);
    await orchestrator.apply(rootConfig('one'), dir);

    const actions = await changes(rootConfig('two'));
    expect(actions.map((action) => action.name)).toEqual(['inner', 'c']);
    expect(isUnknown(actions[1].changes!.content.new)).toBe(true);

    await newOrchestrator().apply(rootConfig('two'), dir);

    expect(await fs.readFile(path.join(dir, 'c.txt'), 'utf8')).toBe('two');
    expect(await changes(rootConfig('two'))).toEqual([]);
  });

  it('plans no changes when a resource reads a module output', async () => {
    await fs.mkdir(path.join(dir, 'm'));
    await fs.writeFile(path.join(dir, 'm', 'main.mf'), 'output "name" { value = "produced" }');
    const config = `
      module "m" { source = "./m" }
      resource "local_file" "c" {
        path = "${path.join(dir, 'c.txt')}"
        content = "\${module.m.name}"
      }
    `;
    await orchestrator.apply(config, dir);

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
    fs.writeFile(path.join(dir, 'm', 'main.mf'), `resource "local_file" "inner" { path = "${path.join(dir, 'inner.txt')}" content = "\${var.text}" }`);

  it('applies a module that reads a resource through its input', async () => {
    await fs.mkdir(path.join(dir, 'm'));
    await writeModule();

    await orchestrator.apply(throughModule('one'), dir);

    expect(await fs.readFile(path.join(dir, 'inner.txt'), 'utf8')).toBe('one');
  });

  it('plans and applies a change that reaches a module through its input', async () => {
    await fs.mkdir(path.join(dir, 'm'));
    await writeModule();
    await orchestrator.apply(throughModule('one'), dir);

    const actions = await changes(throughModule('two'));
    expect(actions.map((action) => action.name)).toEqual(['a', 'inner']);

    await newOrchestrator().apply(throughModule('two'), dir);

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

    await expect(newOrchestrator().plan(config, dir)).rejects.toThrow('variable "missing" is not defined');
  });

  it('plans no changes for a module named after a graph node kind', async () => {
    await fs.mkdir(path.join(dir, 'vars'));
    await fs.writeFile(path.join(dir, 'vars', 'main.mf'), 'output "o" { value = "inner" }');
    const config = `
      module "vars" { source = "./vars" }
      resource "local_file" "b" {
        path = "${path.join(dir, 'b.txt')}"
        content = "\${module.vars.o}"
      }
    `;
    await orchestrator.apply(config, dir);

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

    await orchestrator.apply(config, dir);

    expect(await fs.readFile(path.join(dir, 'b.txt'), 'utf8')).toBe(path.join(dir, 'a.txt'));
    expect(await changes(config)).toEqual([]);
  });

  it('writes resolved values, not syntax, into the state variables', async () => {
    const config = `
      variable "greeting" { default = "hello" }
      module "m" {
        source = "./m"
        text = "\${var.greeting}"
      }
    `;
    await fs.mkdir(path.join(dir, 'm'));
    await fs.writeFile(path.join(dir, 'm', 'main.mf'), `output "echo" { value = "\${var.text}" }`);

    await orchestrator.apply(config, dir);

    const state = await new LocalBackend(dir).read();
    expect(state.variables).toEqual({ '': { greeting: 'hello' }, 'module.m': { text: 'hello' } });
  });

  it('says that modules are read through their outputs', async () => {
    await fs.mkdir(path.join(dir, 'm'));
    await fs.writeFile(path.join(dir, 'm', 'main.mf'), `resource "local_file" "inner" { path = "${path.join(dir, 'inner.txt')}" content = "x" }`);
    const config = `
      module "m" { source = "./m" }
      resource "local_file" "c" {
        path = "${path.join(dir, 'c.txt')}"
        content = "\${module.m.local_file.inner.content}"
      }
    `;

    await expect(newOrchestrator().plan(config, dir)).rejects.toThrow('modules are read through their outputs');
  });

  it('plans one replacement when a forceNew attribute changes', async () => {
    await orchestrator.apply(fileConfig('hello'), dir);
    const moved = fileConfig('hello').replace('a.txt', 'moved.txt');

    const actions = await changes(moved);

    expect(actions.map((action) => action.type)).toEqual(['REPLACE']);
  });

  it('keeps a replaced resource in state and settles on the next plan', async () => {
    await orchestrator.apply(fileConfig('hello'), dir);
    const moved = fileConfig('hello').replace('a.txt', 'moved.txt');

    await newOrchestrator().apply(moved, dir);

    const files = await fs.readdir(dir);
    expect(files.filter((name) => name.endsWith('.txt'))).toEqual(['moved.txt']);
    const state = await new LocalBackend(dir).read();
    expect(state.resources['local_file.a'].id).toBe(path.join(dir, 'moved.txt'));
    expect(await changes(moved)).toEqual([]);
  });
});
