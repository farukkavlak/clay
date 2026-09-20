import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApplyCommand } from '../../src/commands/apply';
import { createValidateCommand } from '../../src/commands/validate';

// The commands read the current directory, so they run from a temp one.
describe('a config with a module', () => {
  let dir: string;
  let cwd: string;
  let printed: string[];

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-config-name-'));
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

  it('is the same for the root config and a module it calls', async () => {
    await fs.mkdir(path.join(dir, 'm'));
    await fs.writeFile(path.join(dir, 'm', 'main.clay'), 'output "text" { value = "from the module" }', 'utf8');
    const root = `
      module "m" { source = "./m" }
      resource "local_file" "a" {
        path = "${path.join(dir, 'a.txt')}"
        content = "\${module.m.text}"
      }
    `;
    await fs.writeFile(path.join(dir, 'main.clay'), root, 'utf8');

    await createApplyCommand().parseAsync(['node', 'clay', '--yes']);

    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('from the module');
  });

  // Providers get plain values, so a relative path means relative to cwd.
  it('leaves a relative path in a module relative to where clay runs', async () => {
    await fs.mkdir(path.join(dir, 'm'));
    await fs.writeFile(path.join(dir, 'm', 'main.clay'), 'resource "local_file" "inner" { path = "./inner.txt"  content = "x" }', 'utf8');
    await fs.writeFile(path.join(dir, 'main.clay'), 'module "m" { source = "./m" }', 'utf8');

    await createApplyCommand().parseAsync(['node', 'clay', '--yes']);

    expect(await fs.readFile(path.join(dir, 'inner.txt'), 'utf8')).toBe('x');
    await expect(fs.access(path.join(dir, 'm', 'inner.txt'))).rejects.toThrow();
  });

  it('is what validate checks', async () => {
    await fs.writeFile(path.join(dir, 'main.clay'), 'variable "v" { default = "x" }', 'utf8');

    await createValidateCommand().parseAsync(['node', 'clay']);

    expect(printed.join('\n')).toContain('Configuration is valid');
  });
});
