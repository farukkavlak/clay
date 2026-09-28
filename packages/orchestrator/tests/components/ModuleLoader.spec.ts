import { CONFIG_FILE, Lexer, Parser } from '@clay/parser';
import { describe, expect, it } from 'vitest';

import { InMemoryFiles } from '../../src/ConfigFiles';
import { ModuleLoader } from '../../src/components/ModuleLoader';
import { ScopeManager } from '../../src/scope/ScopeManager';

const parse = (config: string) => new Parser(new Lexer(config, CONFIG_FILE).tokenize()).parse();

describe('ModuleLoader', () => {
  it('lists resources in the order they are written, those of a module where it is called', async () => {
    const files = new InMemoryFiles({
      'a/main.clay': 'resource "null_resource" "x" {}\nmodule "b" { source = "./b" }\nresource "null_resource" "z" {}',
      'a/b/main.clay': 'resource "null_resource" "y" {}',
    });
    const root = parse('resource "null_resource" "first" {}\nmodule "a" { source = "./a" }\nresource "null_resource" "last" {}');

    const { resources } = await new ModuleLoader(files, new ScopeManager()).loadModuleTree(root);

    expect(resources.map((resource) => resource.uniqueId)).toEqual([
      'null_resource.first',
      'module.a.null_resource.x',
      'module.a.module.b.null_resource.y',
      'module.a.null_resource.z',
      'null_resource.last',
    ]);
  });

  // Handing every resource of a module to one call would overflow the stack on a large one.
  it('loads a large module two levels down', async () => {
    const count = 200_000;
    const big = Array.from({ length: count }, (_, i) => `resource "null_resource" "r${i}" {}`).join('\n');
    const files = new InMemoryFiles({ 'a/main.clay': 'module "big" { source = "./big" }', 'a/big/main.clay': big });

    const { resources } = await new ModuleLoader(files, new ScopeManager()).loadModuleTree(parse('module "a" { source = "./a" }'));

    expect(resources).toHaveLength(count);
    expect(resources[0].uniqueId).toBe('module.a.module.big.null_resource.r0');
    expect(resources.at(-1)?.uniqueId).toBe(`module.a.module.big.null_resource.r${count - 1}`);
  });
});
