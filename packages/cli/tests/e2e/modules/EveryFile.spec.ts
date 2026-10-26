import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApplyCommand } from '../../../src/commands/apply';
import { createPlanCommand } from '../../../src/commands/plan';

// The commands read the current directory, so they run from a temp one.
describe('a directory with several .clay files', () => {
  let dir: string;
  let cwd: string;
  let printed: string[];

  const fileResource = (name: string, content: string) => `resource "local_file" "${name}" {\n  path = "${path.join(dir, `${name}.txt`)}"\n  content = "${content}"\n}`;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-every-file-'));
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

  it('applies the blocks of every file, at the root and in a module, which refer to each other', async () => {
    await fs.mkdir(path.join(dir, 'm'));
    await fs.writeFile(path.join(dir, 'm', 'outputs.clay'), 'output "text" { value = local.text }', 'utf8');
    await fs.writeFile(path.join(dir, 'm', 'locals.clay'), 'locals { text = "from the module" }', 'utf8');
    await fs.writeFile(path.join(dir, 'main.clay'), fileResource('a', '${module.m.text}'), 'utf8');
    await fs.writeFile(path.join(dir, 'modules.clay'), 'module "m" { source = "./m" }', 'utf8');

    await createApplyCommand().parseAsync(['node', 'clay', '--yes']);

    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('from the module');
  });

  it('refuses a block declared in two files, showing the second', async () => {
    await fs.writeFile(path.join(dir, 'a.clay'), fileResource('x', 'one'), 'utf8');
    await fs.writeFile(path.join(dir, 'b.clay'), fileResource('x', 'two'), 'utf8');

    await createPlanCommand().parseAsync(['node', 'clay']);

    const output = printed.join('\n');
    expect(output).toContain('resource "local_file" "x" is declared twice, first on a.clay line 1');
    expect(output).toContain('on b.clay line 1');
  });

  it('refuses a directory with no .clay file', async () => {
    await fs.writeFile(path.join(dir, '.hidden.clay'), fileResource('x', 'one'), 'utf8');

    await createPlanCommand().parseAsync(['node', 'clay']);

    expect(printed.join('\n')).toContain('Planning failed: no .clay file in the directory');
  });

  it('refuses a link to nothing by its name', async () => {
    await fs.writeFile(path.join(dir, 'main.clay'), fileResource('x', 'one'), 'utf8');
    await fs.symlink('nowhere', path.join(dir, 'gone.clay'));

    await createPlanCommand().parseAsync(['node', 'clay']);

    expect(printed.join('\n')).toContain('Planning failed: gone.clay is listed but not found');
  });

  it('applies a saved plan with the files it was made from, not one added after', async () => {
    await fs.writeFile(path.join(dir, 'a.clay'), fileResource('a', 'one'), 'utf8');
    await createPlanCommand().parseAsync(['node', 'clay', '--out', 'plan.json']);
    await fs.writeFile(path.join(dir, 'b.clay'), fileResource('b', 'two'), 'utf8');

    await createApplyCommand().parseAsync(['node', 'clay', 'plan.json']);

    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('one');
    await expect(fs.access(path.join(dir, 'b.txt'))).rejects.toThrow('ENOENT');
  });
});
