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

  // Known bug: `plan` never computes module outputs, so the reference is unknown every time.
  it.fails('plans no changes when a resource reads a module output', async () => {
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
});
