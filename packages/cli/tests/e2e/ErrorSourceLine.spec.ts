import { Orchestrator } from '@clay/orchestrator';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApplyCommand } from '../../src/commands/apply';
import { createPlanCommand } from '../../src/commands/plan';
import { createValidateCommand } from '../../src/commands/validate';

const config = 'output "x" { value = var.missing }';

// The error points at line 1 of the file as it was read, not as it is when the error is shown.
describe('the source line of an error', () => {
  let dir: string;
  let cwd: string;
  let printed: string[];

  const prepend = () => fs.writeFile(path.join(dir, 'main.clay'), `resource "null_resource" "m" {}\n${config}`, 'utf8');

  // Planning and validating begin once main.clay is read, so the file changes after that read.
  const changeOnDiskWhenRunStarts = () => {
    const { plan, validate } = Orchestrator.prototype;
    vi.spyOn(Orchestrator.prototype, 'plan').mockImplementation(async function (this: Orchestrator, ...args) {
      await prepend();
      return plan.apply(this, args);
    });
    vi.spyOn(Orchestrator.prototype, 'validate').mockImplementation(async function (this: Orchestrator, ...args) {
      await prepend();
      return validate.apply(this, args);
    });
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-source-line-'));
    cwd = process.cwd();
    process.chdir(dir);
    printed = [];
    const record = (...args: unknown[]) => printed.push(args.join(' '));
    vi.spyOn(console, 'log').mockImplementation(record);
    vi.spyOn(console, 'error').mockImplementation(record);
    // The command exits the process when it fails, which would take the test runner with it.
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    await fs.writeFile(path.join(dir, 'main.clay'), config, 'utf8');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.chdir(cwd);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it.each([
    ['plan', createPlanCommand],
    ['validate', createValidateCommand],
    ['a plain apply', createApplyCommand],
  ])('is quoted from what %s read when the file changes on disk', async (_, command) => {
    changeOnDiskWhenRunStarts();

    await command().parseAsync(['node', 'clay']);

    expect(printed.join('\n')).toContain('1: output "x" { value = var.missing }');
  });
});
