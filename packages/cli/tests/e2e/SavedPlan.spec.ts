import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { serializePlan } from '@clay/planner';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApplyCommand } from '../../src/commands/apply';
import { createPlanCommand } from '../../src/commands/plan';
import { start } from './start';

const moduleConfig = (text: string) => `output "text" { value = "${text}" }`;

const drain = async (events: AsyncGenerator<{ type: string; error?: Error }>) => {
  for await (const event of events) if (event.type === 'failed') throw event.error;
};

describe('a plan saved to a file', () => {
  let dir: string;

  const newOrchestrator = () => {
    const engine = new Orchestrator(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
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

  const save = async (config: string) => serializePlan(await newOrchestrator().plan(config), config, {});

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-saved-plan-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  // apply reads the current directory, so the command runs from the temp one.
  it('is applied by the CLI without reading the configuration on disk', async () => {
    const saved = await save(fileConfig('planned'));
    await fs.writeFile(path.join(dir, 'plan.json'), JSON.stringify(saved), 'utf8');
    await fs.writeFile(path.join(dir, 'main.clay'), fileConfig('changed'), 'utf8');

    const cwd = process.cwd();
    process.chdir(dir);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // The command exits the process on failure, which would take the test runner with it.
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    try {
      await createApplyCommand().parseAsync(['node', 'clay', 'plan.json']);
    } finally {
      vi.restoreAllMocks();
      process.chdir(cwd);
    }

    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('planned');
  });

  it('carries its modules, so a module edited or removed later changes nothing', async () => {
    await fs.mkdir(path.join(dir, 'm'));
    await fs.writeFile(path.join(dir, 'm', 'main.clay'), moduleConfig('planned'), 'utf8');
    const fromModule = fileConfig(`\${module.m.text}`);
    await fs.writeFile(path.join(dir, 'main.clay'), `module "m" { source = "./m" }\n${fromModule}`, 'utf8');

    const cwd = process.cwd();
    process.chdir(dir);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    try {
      await createPlanCommand().parseAsync(['node', 'clay', '--out', 'plan.json']);
      await fs.rm(path.join(dir, 'm'), { recursive: true });
      await createApplyCommand().parseAsync(['node', 'clay', 'plan.json']);
    } finally {
      vi.restoreAllMocks();
      process.chdir(cwd);
    }

    const saved = JSON.parse(String(await fs.readFile(path.join(dir, 'plan.json'))));
    expect(saved.modules).toEqual({ 'm/main.clay': moduleConfig('planned') });
    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('planned');
  });

  it('runs the actions it carries instead of planning again', async () => {
    const saved = await save(chained());
    const onlyA = saved.actions.filter((action) => action.name === 'a');

    await drain(newOrchestrator().runPlan({ ...saved, actions: onlyA }, saved.config));

    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('hello');
    await expect(fs.access(path.join(dir, 'b.txt'))).rejects.toThrow();
  });

  it('stops when it names a resource the configuration no longer declares', async () => {
    const saved = await save(chained());
    const onlyB = saved.actions.filter((action) => action.name === 'b');

    await expect(drain(newOrchestrator().runPlan({ ...saved, actions: onlyB }, fileConfig('hello')))).rejects.toThrow(
      'The plan has "local_file.b", which the configuration does not declare'
    );
  });

  it('is refused once another run has written the state', async () => {
    const saved = await save(fileConfig('planned'));

    await drain(start(newOrchestrator(), fileConfig('changed')));

    await expect(drain(newOrchestrator().runPlan(saved, saved.config))).rejects.toThrow('The state has changed since the plan was made');
    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('changed');
  });
});
