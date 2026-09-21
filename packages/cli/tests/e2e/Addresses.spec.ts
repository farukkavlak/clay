import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApplyCommand } from '../../src/commands/apply';
import { createPlanCommand } from '../../src/commands/plan';

// The commands read the current directory, so they run from a temp one.
describe('how the CLI names a resource in a module', () => {
  let dir: string;
  let cwd: string;
  let printed: string[];

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-addresses-'));
    await fs.mkdir(path.join(dir, 'm'));
    await fs.writeFile(path.join(dir, 'm', 'main.clay'), `resource "local_file" "f" { path = "${path.join(dir, 'f.txt')}" content = "x" }`, 'utf8');
    await fs.writeFile(path.join(dir, 'main.clay'), 'module "m" { source = "./m" }', 'utf8');
    cwd = process.cwd();
    process.chdir(dir);
    printed = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => printed.push(args.join(' ')));
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.chdir(cwd);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('plans it with its module', async () => {
    await createPlanCommand().parseAsync(['node', 'clay']);

    expect(printed.join('\n')).toContain('module.m.local_file.f will be created');
  });

  it('applies it with its module and counts what it did', async () => {
    await createApplyCommand().parseAsync(['node', 'clay', '--yes']);

    const output = printed.join('\n');
    expect(output).toContain('+ module.m.local_file.f will be created');
    expect(output).toContain('module.m.local_file.f created');
    expect(output).toContain('Resources: 1 added, 0 changed, 0 destroyed');
  });

  it('shows what an apply would change, the way plan does', async () => {
    await createApplyCommand().parseAsync(['node', 'clay', '--yes']);
    await fs.writeFile(path.join(dir, 'm', 'main.clay'), `resource "local_file" "f" { path = "${path.join(dir, 'f.txt')}" content = "y" }`, 'utf8');
    printed.length = 0;

    await createApplyCommand().parseAsync(['node', 'clay', '--yes']);

    const output = printed.join('\n');
    expect(output).toContain('~ module.m.local_file.f will be updated');
    expect(output).toContain('content: "x" -> "y"');
    expect(output).toContain('Plan: 0 to add, 1 to change, 0 to destroy.');
  });
});
