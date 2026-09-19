import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { isUnknown } from '@clay/planner';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApplyCommand } from '../../src/commands/apply';

describe('outputs in the state file', () => {
  let dir: string;

  const newOrchestrator = () => {
    const engine = new Orchestrator(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    return engine;
  };

  const withOutput = (name: string) => `
    resource "local_file" "a" {
      path = "${path.join(dir, 'a.txt')}"
      content = "hello"
    }
    output "${name}" { value = "\${local_file.a.content}" }
  `;

  // b's path sits under a file, so its create fails after a's update has succeeded.
  const failing = () => `
    resource "local_file" "a" {
      path = "${path.join(dir, 'a.txt')}"
      content = "changed"
    }
    resource "local_file" "b" {
      path = "${path.join(dir, 'a.txt', 'b.txt')}"
      content = "never"
    }
    output "greeting" { value = "\${local_file.a.content}" }
  `;

  const run = async (config: string) => {
    for await (const event of newOrchestrator().run(config)) if (event.type === 'failed') return event.error;
    return undefined;
  };

  const stored = async () => new LocalBackend(dir).read();

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-outputs-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('plans a renamed output as a change, with nothing else to do', async () => {
    await run(withOutput('greeting'));

    const plan = await newOrchestrator().plan(withOutput('message'));

    expect(plan.actions.every((action) => action.type === 'NO_OP')).toBe(true);
    expect(plan.outputs).toEqual({ greeting: { old: 'hello', new: undefined }, message: { old: undefined, new: 'hello' } });
  });

  it('plans an output that a pending resource feeds as known after apply', async () => {
    const plan = await newOrchestrator().plan(withOutput('greeting'));

    expect(isUnknown(plan.outputs.greeting.new)).toBe(true);
  });

  it('plans no output change when the state already has it', async () => {
    await run(withOutput('greeting'));

    const plan = await newOrchestrator().plan(withOutput('greeting'));

    expect(plan.outputs).toEqual({});
  });

  // apply reads the current directory, so the command runs from the temp one.
  it('applies a renamed output through the CLI, though no resource changes', async () => {
    await run(withOutput('greeting'));
    await fs.writeFile(path.join(dir, 'main.clay'), withOutput('message'), 'utf8');

    const cwd = process.cwd();
    process.chdir(dir);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    try {
      await createApplyCommand().parseAsync(['node', 'clay', '--yes']);
    } finally {
      vi.restoreAllMocks();
      process.chdir(cwd);
    }

    const state = await stored();
    expect(state.outputs).toEqual({ message: 'hello' });
  });

  it('keeps no outputs from before a run that failed', async () => {
    await run(withOutput('greeting'));

    expect(await run(failing())).toBeInstanceOf(Error);

    const state = await stored();
    expect(state.resources['local_file.a'].attributes.content).toBe('changed');
    expect(state.outputs).toBeUndefined();
  });
});
