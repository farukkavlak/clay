import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApplyCommand } from '../../src/commands/apply';
import { start } from './start';

vi.mock('node:readline/promises');

// apply reads the current directory, so the command runs from the temp one.
describe('the plan apply showed', () => {
  let dir: string;
  let cwd: string;
  let printed: string[];

  const fileConfig = (content: string) => `
    resource "local_file" "a" {
      path = "${path.join(dir, 'a.txt')}"
      content = "${content}"
    }
  `;

  const applyElsewhere = async (config: string) => {
    const engine = new Orchestrator(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    for await (const event of start(engine, config)) if (event.type === 'failed') throw event.error;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-approved-'));
    cwd = process.cwd();
    process.chdir(dir);
    printed = [];
    const record = (...args: unknown[]) => printed.push(args.join(' '));
    vi.spyOn(console, 'log').mockImplementation(record);
    vi.spyOn(console, 'error').mockImplementation(record);
    // The command exits the process when it fails, which would take the test runner with it.
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.chdir(cwd);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('is refused when the state changes while the question is open', async () => {
    await fs.writeFile(path.join(dir, 'main.clay'), fileConfig('mine'), 'utf8');
    // The answer comes after another run has written the state.
    const question = vi.fn(async () => {
      await applyElsewhere(fileConfig('theirs'));
      return 'yes';
    });
    vi.mocked(readline.createInterface).mockReturnValue(Object.assign(new EventTarget(), { question, close: vi.fn() }) as unknown as readline.Interface);

    await createApplyCommand().parseAsync(['node', 'clay']);

    expect(printed.join('\n')).toContain('The state has changed since the plan was made. Plan again.');
    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('theirs');
  });
});
