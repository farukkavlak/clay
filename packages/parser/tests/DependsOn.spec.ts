import { describe, expect, it } from 'vitest';

import { CONFIG_FILE, ConfigError, DataBlock, ModuleBlock, OutputBlock, Parser, ResourceBlock } from '../src';
import { Lexer } from '../src/Lexer';

const parse = (source: string) => new Parser(new Lexer(source, CONFIG_FILE).tokenize()).parse();

const errorOf = (source: string): ConfigError => {
  try {
    parse(source);
  } catch (error) {
    if (error instanceof ConfigError) return error;

    throw error;
  }

  throw new Error('Expected the source to be refused');
};

const at = (line: number, column: number) => ({ file: CONFIG_FILE, line, column });

const WAITS_FOR = 'depends_on is a list of resources, data sources, variables, locals, modules and their outputs, as in [local_file.a]';

describe('Parser - depends_on', () => {
  it("reads a resource's list apart from the attributes, each item where it was written", () => {
    const [block] = parse('resource "t" "a" {\n  path = "a"\n  depends_on = [t.b, data.t.c, var.v, local.l]\n}') as ResourceBlock[];

    expect(block.dependsOn).toEqual([
      { type: 'Reference', value: [{ name: 't' }, { name: 'b' }], position: at(3, 17) },
      { type: 'Reference', value: [{ name: 'data' }, { name: 't' }, { name: 'c' }], position: at(3, 22) },
      { type: 'Reference', value: [{ name: 'var' }, { name: 'v' }], position: at(3, 32) },
      { type: 'Reference', value: [{ name: 'local' }, { name: 'l' }], position: at(3, 39) },
    ]);
    expect(Object.keys(block.attributes)).toEqual(['path']);
  });

  it("reads a data source's list apart from the attributes", () => {
    const [block] = parse('data "t" "d" {\n  path = "a"\n  depends_on = [t.b]\n}') as DataBlock[];

    expect(block.dependsOn).toEqual([{ type: 'Reference', value: [{ name: 't' }, { name: 'b' }], position: at(3, 17) }]);
    expect(Object.keys(block.attributes)).toEqual(['path']);
  });

  it("reads a module call's list apart from its inputs", () => {
    const [block] = parse('module "m" {\n  source = "./m"\n  depends_on = [t.b]\n}') as ModuleBlock[];

    expect(block.dependsOn).toEqual([{ type: 'Reference', value: [{ name: 't' }, { name: 'b' }], position: at(3, 17) }]);
    expect(Object.keys(block.attributes)).toEqual(['source']);
  });

  it("reads an output's list apart from its value", () => {
    const [block] = parse('output "o" {\n  value = 1\n  depends_on = [t.b]\n}') as OutputBlock[];

    expect(block.dependsOn).toEqual([{ type: 'Reference', value: [{ name: 't' }, { name: 'b' }], position: at(3, 17) }]);
    expect(block.value).toMatchObject({ type: 'Number' });
  });

  it('takes a whole module and an output of one', () => {
    const [block] = parse('resource "t" "a" { depends_on = [module.m, module.n.out] }') as ResourceBlock[];

    expect(block.dependsOn).toEqual([
      { type: 'Reference', value: [{ name: 'module' }, { name: 'm' }], position: at(1, 34) },
      { type: 'Reference', value: [{ name: 'module' }, { name: 'n' }, { name: 'out' }], position: at(1, 44) },
    ]);
  });

  it('is an empty list, and left out where the block does not say it', () => {
    const [empty, without] = parse('resource "t" "a" { depends_on = [] }\nresource "t" "b" {}') as ResourceBlock[];

    expect(empty.dependsOn).toEqual([]);
    expect(without).not.toHaveProperty('dependsOn');
  });

  it.each([
    ['one instance', '[t.b[0]]', 'depends_on waits for a whole object: write t.b, not t.b[0]', at(1, 34)],
    ['one instance by key', '[data.t.c["k"]]', 'depends_on waits for a whole object: write data.t.c, not data.t.c["k"]', at(1, 34)],
    ['an attribute', '[t.b.id]', 'depends_on waits for a whole object: write t.b, not t.b.id', at(1, 34)],
    ['a part of a variable', '[var.v.x]', 'depends_on waits for a whole object: write var.v, not var.v.x', at(1, 34)],
    ['a value, not a list', 't.b', WAITS_FOR, at(1, 33)],
    ['a string', '["t.b"]', WAITS_FOR, at(1, 34)],
    ['a call', '[tolist(t.b)]', WAITS_FOR, at(1, 34)],
    ['a [*]', '[t.b[*]]', WAITS_FOR, at(1, 34)],
    ['count.index', '[count.index]', WAITS_FOR, at(1, 34)],
    ['each.key', '[each.key]', WAITS_FOR, at(1, 34)],
    ['path.module', '[path.module]', WAITS_FOR, at(1, 34)],
    ['one instance of a module', '[module.m[0]]', 'depends_on waits for a whole object: write module.m, not module.m[0]', at(1, 34)],
    ['a module by key', '[module.m["k"]]', 'depends_on waits for a whole object: write module.m, not module.m["k"]', at(1, 34)],
    ['an output of one instance', '[module.m[0].out]', 'depends_on waits for a whole object: write module.m.out, not module.m[0].out', at(1, 34)],
    ['a part of an output of one instance', '[module.m[0].out.x]', 'depends_on waits for a whole object: write module.m.out, not module.m[0].out.x', at(1, 34)],
    ['a part of an output', '[module.m.out.x]', 'depends_on waits for a whole object: write module.m.out, not module.m.out.x', at(1, 34)],
  ])('refuses %s, where it is written', (_, list, message, position) => {
    const error = errorOf(`resource "t" "a" { depends_on = ${list} }`);

    expect(error.message).toBe(message);
    expect(error.position).toEqual(position);
  });

  it.each([
    ['a module call', 'module "m" {\n  source = "./m"\n  depends_on = [t.b.id]\n}'],
    ['an output', 'output "o" {\n  value = 1\n  depends_on = [t.b.id]\n}'],
  ])("refuses an item of %s's list where it is written", (_, source) => {
    const error = errorOf(source);

    expect(error.message).toBe('depends_on waits for a whole object: write t.b, not t.b.id');
    expect(error.position).toEqual(at(3, 17));
  });

  it("refuses an item of a data source's list where it is written", () => {
    const error = errorOf('data "t" "d" { depends_on = [t.b.id] }');

    expect(error.message).toBe('depends_on waits for a whole object: write t.b, not t.b.id');
    expect(error.position).toEqual(at(1, 30));
  });
});
