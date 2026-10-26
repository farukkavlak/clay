import { RunEvent } from '@clay/orchestrator';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApplyCommand } from '../../../src/commands/apply';
import { orchestratorIn } from '../helpers';
import { start } from '../start';

describe('a state that cannot be saved after a failed action', () => {
  let dir: string;
  let cwd: string;
  let printed: string[];

  // The command fails and leaves a journal that cannot be written to, except by root.
  const config = () => `
    resource "command_exec" "breaks" {
      command = "touch ${path.join(dir, 'clay.state.json.journal')} && chmod 444 ${path.join(dir, 'clay.state.json.journal')}; exit 1"
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

  it.skipIf(process.getuid?.() === 0)('is reported by the engine next to the action that failed', async () => {
    const engine = orchestratorIn(dir, new LocalProvider());

    const events: RunEvent[] = [];
    for await (const event of start(engine, config())) events.push(event);

    const failed = events.find((event) => event.type === 'failed');
    expect(failed).toMatchObject({ error: { message: expect.stringContaining('Command failed') }, stateError: { code: 'EACCES' } });
  });

  it.skipIf(process.getuid?.() === 0)('is printed by apply before the action error', async () => {
    await fs.writeFile(path.join(dir, 'main.clay'), config(), 'utf8');

    await createApplyCommand().parseAsync(['node', 'clay', '-y']);

    const output = printed.join('\n');
    expect(output).toContain('The state could not be saved: EACCES');
    expect(output.indexOf('The state could not be saved')).toBeLessThan(output.indexOf('Apply failed: command_exec.breaks:'));
  });
});

describe('a state that cannot be written whole at the end of a run', () => {
  let dir: string;
  let cwd: string;
  let printed: string[];

  // The command leaves a directory where the state file is written, after the null resource is made.
  const breaking = (end: string) => `
    resource "null_resource" "made" {}

    resource "command_exec" "breaks" {
      command = "mkdir ${path.join(dir, 'clay.state.json.tmp')}; ${end} # \${null_resource.made.id}"
    }
  `;
  const failing = () => breaking('exit 1');
  // The command succeeds; the output then reads a key the map does not have, which is known only at apply.
  const throwing = () => `
    variable "m" {
      default = { a = "1" }
    }
    ${breaking('printf b')}
    output "x" {
      value = var.m[command_exec.breaks.stdout]
    }
  `;

  const run = async (config: string, events: RunEvent[] = []) => {
    for await (const event of start(orchestratorIn(dir), config)) events.push(event);
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-failed-write-'));
    cwd = process.cwd();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.chdir(cwd);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('is reported after the failure of the action', async () => {
    const events: RunEvent[] = [];

    await run(failing(), events);

    const types = events.map((event) => event.type);
    expect(types.indexOf('unsaved')).toBeGreaterThan(types.indexOf('failed'));
    expect(events.find((event) => event.type === 'unsaved')).toMatchObject({ error: { code: 'EISDIR' } });
  });

  it('leaves the run in the journal, which the state is read with', async () => {
    await run(failing());

    const held = await new LocalBackend(dir).read();
    expect(Object.keys(held.resources)).toEqual(['null_resource.made']);
  });

  it('is printed by apply beside the error of the action', async () => {
    process.chdir(dir);
    printed = [];
    const record = (...args: unknown[]) => printed.push(args.join(' '));
    vi.spyOn(console, 'log').mockImplementation(record);
    vi.spyOn(console, 'error').mockImplementation(record);
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    await fs.writeFile(path.join(dir, 'main.clay'), failing(), 'utf8');

    await createApplyCommand().parseAsync(['node', 'clay', '-y']);

    const output = printed.join('\n');
    expect(output).toContain('The state could not be saved: EISDIR');
    expect(output).toContain('Apply failed: command_exec.breaks:');
  });

  it('is reported before the error the run stopped with, which stays as it was', async () => {
    const events: RunEvent[] = [];

    await expect(run(throwing(), events)).rejects.toMatchObject({ message: 'var.m has no key "b"', position: { line: 13 } });

    expect(events.at(-1)).toMatchObject({ type: 'unsaved', error: { code: 'EISDIR' } });
  });
});
