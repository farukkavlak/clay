import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApplyCommand } from '../../src/commands/apply';
import { createOutputCommand } from '../../src/commands/output';
import { createPlanCommand } from '../../src/commands/plan';
import { createValidateCommand } from '../../src/commands/validate';

// A link to itself is there but cannot be opened, which is not the same as not being there.
describe('a file that is there but cannot be opened', () => {
  let dir: string;
  let cwd: string;
  let printed: string[];

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-unreadable-'));
    cwd = process.cwd();
    process.chdir(dir);
    printed = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => printed.push(args.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => printed.push(args.join(' ')));
    // The commands exit the process when they fail, which would take the test runner with it.
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.chdir(cwd);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it.each([
    ['plan', () => createPlanCommand().parseAsync(['node', 'clay']), 'Planning failed:'],
    ['validate', () => createValidateCommand().parseAsync(['node', 'clay']), 'Validation failed:'],
    ['apply', () => createApplyCommand().parseAsync(['node', 'clay', '--yes']), 'Apply failed:'],
  ])('is a configuration %s says it cannot read, not one it cannot find', async (_, run, prefix) => {
    await fs.symlink('main.clay', path.join(dir, 'main.clay'));

    await run();

    const output = printed.join('\n');
    expect(output).toContain(prefix);
    expect(output).toContain('ELOOP');
    expect(output).not.toContain('not found');
  });

  it('is a module source plan says it cannot read, not one it cannot find', async () => {
    await fs.mkdir(path.join(dir, 'm'));
    await fs.symlink('main.clay', path.join(dir, 'm', 'main.clay'));
    await fs.writeFile(path.join(dir, 'main.clay'), 'module "m" { source = "./m" }', 'utf8');

    await createPlanCommand().parseAsync(['node', 'clay']);

    const output = printed.join('\n');
    expect(output).toContain('Planning failed:');
    expect(output).toContain('ELOOP');
    expect(output).not.toContain('not found');
  });

  it('leaves a state file that is not there called missing, as before', async () => {
    await createOutputCommand().parseAsync(['node', 'clay']);

    expect(printed.join('\n')).toContain(`No state file found at ${path.join(process.cwd(), 'clay.state.json')}`);
    expect(process.exit).not.toHaveBeenCalled();
  });

  it('is a state file output says it cannot read, not one it cannot find', async () => {
    await fs.symlink('clay.state.json', path.join(dir, 'clay.state.json'));

    await createOutputCommand().parseAsync(['node', 'clay']);

    const output = printed.join('\n');
    expect(output).toContain('Error reading outputs:');
    expect(output).toContain('ELOOP');
    expect(output).not.toContain('No state file found');
  });
});
