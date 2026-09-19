import { Orchestrator } from '@clay/orchestrator';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createOutputCommand } from '../../src/commands/output';
import { createStateCommand } from '../../src/commands/state';

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

  const applyConfig = async () => {
    const engine = new Orchestrator(new StateManager(new LocalBackend(dir)));
    engine.registerProvider(new LocalProvider());
    for await (const event of engine.run(config(), dir)) if (event.type === 'failed') throw event.error;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-state-cmd-'));
    cwd = process.cwd();
    process.chdir(dir);
    printed = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => printed.push(args.join(' ')));
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

    expect(printed.join('\n')).toContain('content = "hello"');
  });

  it('reads the file --state names', async () => {
    await applyConfig();
    await fs.rename(path.join(dir, 'clay.state.json'), path.join(dir, 'moved.json'));

    await createStateCommand().parseAsync(['node', 'clay', 'list', '--state', 'moved.json']);

    expect(printed).toContain('local_file.a');
  });

  it('reads what the engine wrote for output', async () => {
    await applyConfig();

    await createOutputCommand().parseAsync(['node', 'clay', '--json']);

    expect(JSON.parse(printed.join('\n'))).toEqual({ file: path.join(dir, 'a.txt') });
  });

  it('does not take a variable for an output', async () => {
    const onlyAVariable = 'variable "greeting" { default = "hi" }';
    const engine = new Orchestrator(new StateManager(new LocalBackend(dir)));
    engine.registerProvider(new LocalProvider());
    for await (const event of engine.run(onlyAVariable, dir)) if (event.type === 'failed') throw event.error;

    await createOutputCommand().parseAsync(['node', 'clay']);

    expect(printed.join('\n')).toContain('No outputs found');
  });

  it('says where it looked when there is no state file', async () => {
    await createOutputCommand().parseAsync(['node', 'clay']);

    expect(printed.join('\n')).toContain(path.join(process.cwd(), 'clay.state.json'));
  });
});
