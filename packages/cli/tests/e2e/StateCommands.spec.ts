import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createOutputCommand } from '../../src/commands/output';
import { createStateCommand } from '../../src/commands/state';
import { start } from './start';

// The commands read the current directory, so they run from a temp one.
describe('state and output against a real state file', () => {
  let dir: string;
  let cwd: string;
  let printed: string[];

  const config = () => `
    variable "greeting" { default = "hi" }
    resource "local_file" "a" {
      path = "${path.join(dir, 'a.txt')}"
      content = "hello"
    }
    output "file" { value = "\${local_file.a.id}" }
  `;

  const newOrchestrator = () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    return engine;
  };

  const run = async (configContent: string) => {
    for await (const event of start(newOrchestrator(), configContent)) if (event.type === 'failed') throw event.error;
  };

  const applyConfig = () => run(config());

  const stored = () => new LocalBackend(dir).read();

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

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-state-cmd-'));
    cwd = process.cwd();
    process.chdir(dir);
    printed = [];
    const record = (...args: unknown[]) => printed.push(args.join(' '));
    vi.spyOn(console, 'log').mockImplementation(record);
    vi.spyOn(console, 'error').mockImplementation(record);
    // The commands exit the process when they fail, which would take the test runner with it.
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.chdir(cwd);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('lists the resources an apply wrote', async () => {
    await applyConfig();

    await createStateCommand().parseAsync(['node', 'clay', 'list']);

    expect(printed).toContain('local_file.a');
  });

  it('shows a resource an apply wrote', async () => {
    await applyConfig();

    await createStateCommand().parseAsync(['node', 'clay', 'show', 'local_file.a']);

    expect(printed.join('\n')).toContain('resource "local_file" "a" {');
    expect(printed.join('\n')).toContain('content = "hello"');
  });

  it('says the state has no resources once rm takes the last one out', async () => {
    await applyConfig();

    await createStateCommand().parseAsync(['node', 'clay', 'rm', 'local_file.a']);
    printed.length = 0;
    await createStateCommand().parseAsync(['node', 'clay', 'list']);

    expect(printed.join('\n')).toContain(`No resources in ${path.join(process.cwd(), 'clay.state.json')}`);
  });

  it('says where state list looked when there is no state file', async () => {
    await createStateCommand().parseAsync(['node', 'clay', 'list']);

    expect(printed.join('\n')).toContain(`No state file found at ${path.join(process.cwd(), 'clay.state.json')}`);
  });

  it('drops the outputs when rm takes a resource out', async () => {
    await applyConfig();

    await createStateCommand().parseAsync(['node', 'clay', 'rm', 'local_file.a']);

    const state = await new LocalBackend(dir).read();
    expect(state.outputs).toBeUndefined();
  });

  it('drops the outputs when mv renames a resource', async () => {
    await applyConfig();

    await createStateCommand().parseAsync(['node', 'clay', 'mv', 'local_file.a', 'local_file.b']);

    const state = await new LocalBackend(dir).read();
    expect(state.outputs).toBeUndefined();
  });

  it('moves the whole entry with mv, so a later delete finds it', async () => {
    await applyConfig();

    await createStateCommand().parseAsync(['node', 'clay', 'mv', 'local_file.a', 'local_file.renamed']);

    const moved = await stored();
    expect(moved.resources['local_file.renamed']).toMatchObject({ resourceType: 'local_file', name: 'renamed', modulePath: [] });

    // The configuration drops the resource; the delete has to find the moved entry.
    await run('');
    const emptied = await stored();
    expect(emptied.resources).toEqual({});
    await expect(fs.access(path.join(dir, 'a.txt'))).rejects.toThrow();
  });

  it('moves a resource into a module with mv', async () => {
    await applyConfig();

    await createStateCommand().parseAsync(['node', 'clay', 'mv', 'local_file.a', 'module.m.local_file.a']);

    const state = await stored();
    expect(state.resources['module.m.local_file.a']).toMatchObject({ name: 'a', modulePath: ['m'] });
  });

  it('renames what other resources read from when mv moves one', async () => {
    await run(chained());

    await createStateCommand().parseAsync(['node', 'clay', 'mv', 'local_file.a', 'local_file.first']);

    const state = await stored();
    expect(state.resources['local_file.b'].dependencies).toEqual(['local_file.first']);
  });

  it('refuses an mv that changes the type', async () => {
    await applyConfig();

    await createStateCommand().parseAsync(['node', 'clay', 'mv', 'local_file.a', 'random_string.a']);

    expect(printed.join('\n')).toContain('Cannot move local_file.a to random_string.a: the type changes');
    const state = await stored();
    expect(state.resources['local_file.a']).toBeDefined();
  });

  it('reads what the engine wrote for output', async () => {
    await applyConfig();

    await createOutputCommand().parseAsync(['node', 'clay', '--json']);

    expect(JSON.parse(printed.join('\n'))).toEqual({ file: path.join(dir, 'a.txt') });
  });

  it('does not take a variable for an output', async () => {
    const onlyAVariable = 'variable "greeting" { default = "hi" }';
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    for await (const event of start(engine, onlyAVariable)) if (event.type === 'failed') throw event.error;

    await createOutputCommand().parseAsync(['node', 'clay']);

    expect(printed.join('\n')).toContain('No outputs found');
  });

  it('says where output looked when there is no state file', async () => {
    await createOutputCommand().parseAsync(['node', 'clay']);

    expect(printed.join('\n')).toContain(`No state file found at ${path.join(process.cwd(), 'clay.state.json')}`);
  });
});
