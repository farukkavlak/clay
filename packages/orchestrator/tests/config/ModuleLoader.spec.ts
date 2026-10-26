import { ConfigError } from '@clay/parser';
import { describe, expect, it } from 'vitest';

import { InMemoryFiles } from '../../src/config/ConfigFiles';
import { ModuleLoader } from '../../src/config/ModuleLoader';
import { ScopeManager } from '../../src/config/ScopeManager';

describe('ModuleLoader', () => {
  it('lists resources in the order they are written, those of a module where it is called', async () => {
    const files = new InMemoryFiles({
      'main.clay': 'resource "null_resource" "first" {}\nmodule "a" { source = "./a" }\nresource "null_resource" "last" {}',
      'a/main.clay': 'resource "null_resource" "x" {}\nmodule "b" { source = "./b" }\nresource "null_resource" "z" {}',
      'a/b/main.clay': 'resource "null_resource" "y" {}',
    });

    const { resources } = await new ModuleLoader(files, new ScopeManager()).loadModuleTree();

    expect(resources.map((resource) => resource.uniqueId)).toEqual([
      'null_resource.first',
      'module.a.null_resource.x',
      'module.a.module.b.null_resource.y',
      'module.a.null_resource.z',
      'null_resource.last',
    ]);
  });

  it('reads every .clay file of a directory, in the order of their names', async () => {
    const files = new InMemoryFiles({
      'main.clay': 'module "a" { source = "./a" }',
      'b.clay': 'resource "null_resource" "b" {}',
      'a/z.clay': 'resource "null_resource" "z" {}',
      'a/y.clay': 'resource "null_resource" "y" {}',
    });

    const { resources } = await new ModuleLoader(files, new ScopeManager()).loadModuleTree();

    expect(resources.map((resource) => resource.uniqueId)).toEqual(['null_resource.b', 'module.a.null_resource.y', 'module.a.null_resource.z']);
  });

  it('skips a hidden file and a file that is not .clay', async () => {
    const files = new InMemoryFiles({
      'main.clay': 'resource "null_resource" "a" {}',
      '.draft.clay': 'resource "null_resource" "hidden" {}',
      'notes.txt': 'not a configuration',
    });

    const { resources } = await new ModuleLoader(files, new ScopeManager()).loadModuleTree();

    expect(resources.map((resource) => resource.uniqueId)).toEqual(['null_resource.a']);
  });

  it.each([
    ['none', {}],
    ['only a hidden one', { '.main.clay': 'resource "null_resource" "x" {}' }],
    ['only one in a directory below', { 'a/main.clay': 'resource "null_resource" "x" {}' }],
  ])('refuses a root with no .clay file, %s', async (_, held) => {
    await expect(new ModuleLoader(new InMemoryFiles(held), new ScopeManager()).loadModuleTree()).rejects.toThrow(/^no \.clay file in the directory$/);
  });

  it('refuses a module whose directory has no .clay file, at its source', async () => {
    const files = new InMemoryFiles({ 'main.clay': 'module "a" {\n  source = "./a"\n}', 'a/notes.txt': '' });

    const error = await new ModuleLoader(files, new ScopeManager()).loadModuleTree().catch((error_: unknown) => error_);

    expect(error).toBeInstanceOf(ConfigError);
    expect(error).toMatchObject({ message: 'module "a" has no .clay file in directory "a"', position: { file: 'main.clay', line: 2, column: 12 } });
  });

  it('refuses a listed file it cannot find', async () => {
    const none = new InMemoryFiles({});
    const files = { list: () => ['main.clay'], read: (file: string) => none.read(file) };

    await expect(new ModuleLoader(files, new ScopeManager()).loadModuleTree()).rejects.toThrow(/^main\.clay is listed but not found$/);
  });

  // Spreading every resource into one call would overflow the stack on a large module.
  // Parsing 200,000 blocks takes seconds alone and longer beside the rest of the suite.
  it('loads a large module two levels down', async () => {
    const count = 200_000;
    const big = Array.from({ length: count }, (_, i) => `resource "null_resource" "r${i}" {}`).join('\n');
    const files = new InMemoryFiles({ 'main.clay': 'module "a" { source = "./a" }', 'a/main.clay': 'module "big" { source = "./big" }', 'a/big/main.clay': big });

    const { resources } = await new ModuleLoader(files, new ScopeManager()).loadModuleTree();

    expect(resources).toHaveLength(count);
    expect(resources[0].uniqueId).toBe('module.a.module.big.null_resource.r0');
    expect(resources.at(-1)?.uniqueId).toBe(`module.a.module.big.null_resource.r${count - 1}`);
  }, 30_000);

  it('reads a module two blocks call once per load, so a file changed between them is loaded as it was first read', async () => {
    let reads = 0;
    const changing = {
      list: (dir: string) => (dir === '.' ? ['main.clay'] : ['m.clay']),
      read: (file: string) => (file === 'main.clay' ? 'module "a" { source = "./m" }\nmodule "b" { source = "./m" }' : `resource "null_resource" "v${++reads}" {}`),
    };
    const loader = new ModuleLoader(changing, new ScopeManager());

    const first = await loader.loadModuleTree();
    const second = await loader.loadModuleTree();

    expect(first.resources.map((resource) => resource.uniqueId)).toEqual(['module.a.null_resource.v1', 'module.b.null_resource.v1']);
    expect(second.resources.map((resource) => resource.uniqueId)).toEqual(['module.a.null_resource.v2', 'module.b.null_resource.v2']);
  });
});
