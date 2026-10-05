import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApplyCommand } from '../../src/commands/apply';
import { createPlanCommand } from '../../src/commands/plan';

const write = async (file: string, content: string) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, 'utf8');
};

describe('a module naming its own directory', () => {
  let dir: string;

  const newOrchestrator = () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    return engine;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-path-module-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  // An input is read in the call, so it gets the caller's directory.
  it('reads the directory of the module it is written in, relative to the root', async () => {
    await write(
      path.join(dir, 'web', 'main.clay'),
      `
      module "shared" { source = "../shared" from = path.module }
      output "dir" { value = path.module }
      output "root" { value = path.root }
      output "shared_dir" { value = module.shared.dir }
      output "from" { value = module.shared.from }
    `
    );
    await write(
      path.join(dir, 'shared', 'main.clay'),
      `
      variable "from" { default = "" }
      output "dir" { value = path.module }
      output "from" { value = var.from }
    `
    );
    const config = `
      module "web" { source = "./web" }
      output "root_dir" { value = path.module }
      output "web_dir" { value = module.web.dir }
      output "web_root" { value = module.web.root }
      output "shared_dir" { value = module.web.shared_dir }
      output "shared_from" { value = module.web.from }
    `;

    const { outputs } = await newOrchestrator().plan(config);

    expect(outputs.root_dir.new?.value).toBe('.');
    expect(outputs.web_dir.new?.value).toBe('web');
    expect(outputs.web_root.new?.value).toBe('.');
    expect(outputs.shared_dir.new?.value).toBe('shared');
    expect(outputs.shared_from.new?.value).toBe('web');
  });

  it('reads the same directory in every instance of a module called with count', async () => {
    await write(path.join(dir, 'web', 'main.clay'), 'output "dir" { value = path.module }');
    const config = `
      module "web" {
        count = 2
        source = "./web"
      }
      output "dirs" { value = [module.web[0].dir, module.web[1].dir] }
    `;

    const { outputs } = await newOrchestrator().plan(config);

    expect(outputs.dirs.new?.value).toEqual(['web', 'web']);
  });

  // apply reads the current directory, so the commands run from the temp one.
  it('writes a file next to the module from a plan saved to a file', async () => {
    await write(path.join(dir, 'web', 'main.clay'), `resource "local_file" "page" { path = "\${path.module}/index.html" content = "hi" }`);
    await write(path.join(dir, 'main.clay'), 'module "web" { source = "./web" }');

    const cwd = process.cwd();
    process.chdir(dir);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    try {
      await createPlanCommand().parseAsync(['node', 'clay', '--out', 'plan.json']);
      await createApplyCommand().parseAsync(['node', 'clay', 'plan.json']);
    } finally {
      vi.restoreAllMocks();
      process.chdir(cwd);
    }

    expect(await fs.readFile(path.join(dir, 'web', 'index.html'), 'utf8')).toBe('hi');
  });
});
