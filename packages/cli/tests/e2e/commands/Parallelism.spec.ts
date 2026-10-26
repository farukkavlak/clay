import { Orchestrator } from '@clay/orchestrator';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApplyCommand } from '../../../src/commands/apply';
import { createPlanCommand } from '../../../src/commands/plan';

describe('apply --parallelism', () => {
  let dir: string;
  let cwd: string;
  let printed: string[];
  let runPlan: ReturnType<typeof vi.spyOn>;

  const run = async (command: typeof createApplyCommand, args: string[]) => {
    await command().parseAsync(['node', 'clay', ...args]);
    return printed.join('\n');
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-parallelism-'));
    await fs.writeFile(path.join(dir, 'main.clay'), `resource "local_file" "a" { path = "${path.join(dir, 'a.txt')}" content = "hi" }`, 'utf8');
    cwd = process.cwd();
    process.chdir(dir);
    printed = [];
    const record = (...args: unknown[]) => printed.push(args.join(' '));
    vi.spyOn(console, 'log').mockImplementation(record);
    vi.spyOn(console, 'error').mockImplementation(record);
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    runPlan = vi.spyOn(Orchestrator.prototype, 'runPlan');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.chdir(cwd);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('hands the number to the run', async () => {
    expect(await run(createApplyCommand, ['-y', '--parallelism', '3'])).toContain('Apply complete!');

    expect(runPlan).toHaveBeenCalledWith(expect.anything(), { parallelism: 3, signal: expect.any(AbortSignal) });
  });

  it('leaves the engine its own number when none is given', async () => {
    await run(createApplyCommand, ['-y']);

    expect(runPlan).toHaveBeenCalledWith(expect.anything(), { parallelism: undefined, signal: expect.any(AbortSignal) });
  });

  it('applies a saved plan with it, since a plan does not hold how many run at once', async () => {
    await run(createPlanCommand, ['--out', 'plan.json']);

    expect(await run(createApplyCommand, ['plan.json', '--parallelism', '2'])).toContain('Apply complete!');
    expect(runPlan).toHaveBeenCalledWith(expect.anything(), { parallelism: 2, signal: expect.any(AbortSignal) });
  });

  it.each(['0', '-1', '2.5', 'many', '', '01', '1e3'])('refuses %j', async (value) => {
    const command = createApplyCommand()
      .exitOverride()
      .configureOutput({ writeErr: () => {} });

    await expect(command.parseAsync(['node', 'clay', '-y', '--parallelism', value])).rejects.toThrow(
      `option '--parallelism <n>' argument '${value}' is invalid. --parallelism is a whole number from 1`
    );
    expect(runPlan).not.toHaveBeenCalled();
  });
});
