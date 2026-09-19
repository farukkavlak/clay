import { Orchestrator } from '@miniform/orchestrator';
import { serializePlan } from '@miniform/planner';
import { LocalProvider } from '@miniform/provider-local';
import { LocalBackend, StateManager } from '@miniform/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApplyCommand } from '../../src/commands/apply';

const drain = async (events: AsyncGenerator<{ type: string; error?: Error }>) => {
  for await (const event of events) if (event.type === 'failed') throw event.error;
};

describe('a plan saved to a file', () => {
  let dir: string;

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

  const chained = () => `
    resource "local_file" "a" {
      path = "${path.join(dir, 'a.txt')}"
      content = "hello"
    }
    resource "local_file" "b" {
      path = "${path.join(dir, 'b.txt')}"
      content = "\${local_file.a.content}"
    }
  `;

  const save = async (config: string) => serializePlan(await newOrchestrator().plan(config, dir), config);

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'miniform-saved-plan-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  // apply reads the current directory, so the command runs from the temp one.
  it('is applied by the CLI without reading the configuration on disk', async () => {
    const saved = await save(fileConfig('planned'));
    await fs.writeFile(path.join(dir, 'plan.json'), JSON.stringify(saved), 'utf8');
    await fs.writeFile(path.join(dir, 'main.mini'), fileConfig('changed'), 'utf8');

    const cwd = process.cwd();
    process.chdir(dir);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // The command exits the process on failure, which would take the test runner with it.
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    try {
      await createApplyCommand().parseAsync(['node', 'miniform', 'plan.json']);
    } finally {
      vi.restoreAllMocks();
      process.chdir(cwd);
    }

    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('planned');
  });

  it('runs the actions it carries instead of planning again', async () => {
    const saved = await save(chained());
    const onlyA = saved.actions.filter((action) => action.name === 'a');

    await drain(newOrchestrator().runPlan(onlyA, saved.config, dir));

    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('hello');
    await expect(fs.access(path.join(dir, 'b.txt'))).rejects.toThrow();
  });

  it('stops when it names a resource the configuration no longer declares', async () => {
    const saved = await save(chained());
    const onlyB = saved.actions.filter((action) => action.name === 'b');

    await expect(drain(newOrchestrator().runPlan(onlyB, fileConfig('hello'), dir))).rejects.toThrow('The plan has "local_file.b", which the configuration does not declare');
  });

  it('runs against the configuration it was made from', async () => {
    const saved = await save(fileConfig('planned'));

    // The configuration on disk moves on; the saved plan does not.
    await drain(newOrchestrator().run(fileConfig('changed'), dir));
    await drain(newOrchestrator().runPlan(saved.actions, saved.config, dir));

    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('planned');
  });
});
