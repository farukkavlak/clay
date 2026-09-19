import { Orchestrator } from '@miniform/orchestrator';
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

  // The planner compares resolved state values with raw config values, so every plan
  // after an apply asks for a replacement.
  describe('known planner bug', () => {
    it.fails('plans no changes right after an apply', async () => {
      await orchestrator.apply(fileConfig('hello'), dir);

      expect(await changes(fileConfig('hello'))).toEqual([]);
    });

    it.fails('plans no changes when the config uses a variable', async () => {
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

    it.fails('plans an update, not a replacement, when only the content changes', async () => {
      await orchestrator.apply(fileConfig('hello'), dir);

      const actions = await changes(fileConfig('bye'));

      expect(actions.map((action) => action.type)).toEqual(['UPDATE']);
      expect(actions[0].changes).toEqual({ content: { old: 'hello', new: 'bye' } });
    });
  });
});
