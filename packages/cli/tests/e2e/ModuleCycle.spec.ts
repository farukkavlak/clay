import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('a module source that is met twice', () => {
  let dir: string;

  const planned = (config: string) => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());

    return engine.plan(config);
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-module-cycle-'));
    await fs.mkdir(path.join(dir, 'a'));
    await fs.mkdir(path.join(dir, 'b'));
    await fs.mkdir(path.join(dir, 'outer'));
    await fs.mkdir(path.join(dir, 'leaf'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('is refused with the path that leads back to it', async () => {
    await fs.writeFile(path.join(dir, 'a', 'main.clay'), `module "b" { source = "../b" }`, 'utf8');
    await fs.writeFile(path.join(dir, 'b', 'main.clay'), `module "a" { source = "../a" }`, 'utf8');

    await expect(planned(`module "a" { source = "./a" }`)).rejects.toThrow(/Module source cycle detected: \. -> a -> b -> a$/);
  });

  // Two siblings inside a module load one after the other, each one level deep, so the second must not see the path the first walked.
  it('is loaded again when two modules side by side name it', async () => {
    await fs.writeFile(path.join(dir, 'leaf', 'main.clay'), `resource "local_file" "one" { path = "${path.join(dir, 'one.txt')}" content = "one" }`, 'utf8');
    await fs.writeFile(path.join(dir, 'a', 'main.clay'), `module "leaf" { source = "../leaf" }`, 'utf8');
    await fs.writeFile(
      path.join(dir, 'outer', 'main.clay'),
      `
      module "first" { source = "../a" }
      module "second" { source = "../a" }
    `,
      'utf8'
    );

    const { actions } = await planned(`module "outer" { source = "./outer" }`);

    expect(actions.map((action) => [...(action.modulePath ?? []), action.resourceType, action.name].join('.'))).toEqual([
      'outer.first.leaf.local_file.one',
      'outer.second.leaf.local_file.one',
    ]);
  });
});
