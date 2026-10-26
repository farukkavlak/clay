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

  it('refuses a root with no main.clay', async () => {
    const files = new InMemoryFiles({ 'a/main.clay': 'resource "null_resource" "x" {}' });

    await expect(new ModuleLoader(files, new ScopeManager()).loadModuleTree()).rejects.toThrow(/^main\.clay not found$/);
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
      read: (file: string) => (file === 'main.clay' ? 'module "a" { source = "./m" }\nmodule "b" { source = "./m" }' : `resource "null_resource" "v${++reads}" {}`),
    };
    const loader = new ModuleLoader(changing, new ScopeManager());

    const first = await loader.loadModuleTree();
    const second = await loader.loadModuleTree();

    expect(first.resources.map((resource) => resource.uniqueId)).toEqual(['module.a.null_resource.v1', 'module.b.null_resource.v1']);
    expect(second.resources.map((resource) => resource.uniqueId)).toEqual(['module.a.null_resource.v2', 'module.b.null_resource.v2']);
  });
});
