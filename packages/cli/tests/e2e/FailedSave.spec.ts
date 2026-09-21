import { DiskFiles, Orchestrator, RunEvent } from '@clay/orchestrator';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApplyCommand } from '../../src/commands/apply';
import { start } from './start';

describe('a state that cannot be saved after a failed action', () => {
  let dir: string;
  let cwd: string;
  let printed: string[];

  // The command fails, and leaves a directory where the state would be written next.
  const config = () => `
    resource "command_exec" "breaks" {
      command = "mkdir ${path.join(dir, 'clay.state.json.tmp')}; exit 1"
    }
  `;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-failed-save-'));
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

  it('is reported by the engine next to the action that failed', async () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());

    const events: RunEvent[] = [];
    for await (const event of start(engine, config())) events.push(event);

    const failed = events.find((event) => event.type === 'failed');
    expect(failed).toMatchObject({ error: { message: expect.stringContaining('Command failed') }, stateError: { code: 'EISDIR' } });
  });

  it('is printed by apply before the action error', async () => {
    await fs.writeFile(path.join(dir, 'main.clay'), config(), 'utf8');

    await createApplyCommand().parseAsync(['node', 'clay', '-y']);

    const output = printed.join('\n');
    expect(output).toContain('The state could not be saved: EISDIR');
    expect(output.indexOf('The state could not be saved')).toBeLessThan(output.indexOf('Apply failed: command_exec.breaks:'));
  });
});
