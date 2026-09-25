import { Address } from '@clay/contracts';
import { AttributeValue, ReferenceNode, Statement } from '@clay/parser';
import { describe, expect, it } from 'vitest';

import { DependencyGraphBuilder } from '../../src/components/DependencyGraphBuilder';
import { LoadedModule, LoadedResource } from '../../src/components/ModuleLoader';
import { ReferenceScanner } from '../../src/resolvers/ReferenceScanner';
import { moduleBlock, ref, resourceBlock, str, variableBlock } from '../ast';

function resource(name: string, attributes: Record<string, AttributeValue> = {}, modulePath: string[] = []): LoadedResource {
  const address = new Address(modulePath, 'resource', name);
  return { uniqueId: address.toString(), address, block: resourceBlock('resource', name, attributes) };
}

function module(modulePath: string[], program: Statement[]): LoadedModule {
  return { address: new Address(modulePath, '', ''), program };
}

describe('DependencyGraphBuilder', () => {
  const builder = new DependencyGraphBuilder(new ReferenceScanner());

  it('should run a resource after the one it reads from', () => {
    const main = resource('main', { id: ref('resource', 'dep', 'id') });

    const graph = builder.buildExecutionGraph([main, resource('dep')], []);

    expect(graph.topologicalSort()).toEqual([['resource.dep'], ['resource.main']]);
  });

  it('should keep resources that do not read from each other in one layer', () => {
    const graph = builder.buildExecutionGraph([resource('a'), resource('b')], []);

    expect(graph.topologicalSort()).toEqual([['resource.a', 'resource.b']]);
  });

  it('should run a module output after the resource it reads from', () => {
    const modules = [
      {
        address: new Address(['app'], '', ''),
        program: [{ type: 'Output', name: 'ip', value: { type: 'Reference', value: ['resource', 'instance', 'ip'] } }],
      },
    ] as LoadedModule[];

    const graph = builder.buildExecutionGraph([resource('instance', {}, ['app'])], modules);

    expect(graph.topologicalSort()).toEqual([['module.app.resource.instance'], ['module.app.outputs:ip']]);
  });

  it('should reject a reference to a resource the config does not declare', () => {
    const main = resource('main', { id: ref('resource', 'typo', 'id') });

    expect(() => builder.buildExecutionGraph([main], [])).toThrow('"resource.typo" is not declared in the configuration');
  });

  // A string may hold several references, so an error has to name the place of the one that is missing.
  it('should point at the missing reference, not at the template it sits in', () => {
    const typo: ReferenceNode = { type: 'Reference', value: ['resource', 'typo', 'id'], position: { file: 'main.clay', line: 3, column: 9 } };
    const main = resource('main', { line: { type: 'Template', value: ['id ', typo], position: { file: 'main.clay', line: 3, column: 1 } } });

    expect(() => builder.buildExecutionGraph([main], [])).toThrow(expect.objectContaining({ position: typo.position }));
  });

  // A value built by hand may carry no position of its own; the value it sits in still places it.
  it('should place a missing reference with no position at the value it sits in', () => {
    const at = { file: 'main.clay', line: 3, column: 1 };
    const typo = { type: 'Reference', value: ['resource', 'typo', 'id'] } as ReferenceNode;
    const main = resource('main', { line: { type: 'Template', value: ['id ', typo], position: at } });

    expect(() => builder.buildExecutionGraph([main], [])).toThrow(expect.objectContaining({ position: at }));
  });

  it('should run a variable after the resource its default reads', () => {
    const root = module([], [variableBlock('id', { default: ref('resource', 'dep', 'id') })]);

    const graph = builder.buildExecutionGraph([resource('dep')], [root]);

    expect(graph.topologicalSort()).toEqual([['resource.dep'], ['vars:id']]);
  });

  // A resource's key is its address, so a variable named like one would take its node if both spelled their kind the same way.
  it('keeps a variable and a resource whose address reads like one apart', () => {
    const address = new Address([], 'vars', 'x');
    const named: LoadedResource = { uniqueId: address.toString(), address, block: resourceBlock('vars', 'x', {}) };
    const root = module([], [variableBlock('x', { default: str('1') })]);

    const graph = builder.buildExecutionGraph([named], [root]);

    const kinds = graph
      .topologicalSort()
      .flat()
      .map((key) => graph.getNode(key)!.kind)
      .sort();

    expect(kinds).toEqual(['resource', 'variable']);
  });

  it('should read a module input where the module is called and hand it to the resource inside', () => {
    const root = module([], [moduleBlock('m', { source: str('./m'), text: ref('resource', 'dep', 'id') })]);
    const child = module(['m'], []);
    const inner = resource('inner', { content: ref('var', 'text') }, ['m']);

    const graph = builder.buildExecutionGraph([resource('dep'), inner], [root, child]);

    expect(graph.topologicalSort()).toEqual([['resource.dep'], ['module.m.vars:text'], ['module.m.resource.inner']]);
    expect(graph.getNode('module.m.vars:text')).toMatchObject({ kind: 'variable', context: root.address });
  });

  it('should list the resources a resource reads from, looking through a module input', () => {
    const root = module([], [moduleBlock('m', { source: str('./m'), text: ref('resource', 'dep', 'id') })]);
    const child = module(['m'], []);
    const inner = resource('inner', { content: ref('var', 'text'), other: ref('resource', 'peer', 'id') }, ['m']);

    const graph = builder.buildExecutionGraph([resource('dep'), resource('peer', {}, ['m']), inner], [root, child]);

    expect(builder.resourceDependencies(graph, 'module.m.resource.inner')).toEqual(['module.m.resource.peer', 'resource.dep']);
    expect(builder.resourceDependencies(graph, 'resource.dep')).toEqual([]);
  });

  it('should let the input passed to a module win over the default declared inside it', () => {
    const passed = str('passed');
    const declared = str('declared');
    const child = module(['m'], [variableBlock('text', { default: declared })]);
    const root = module([], [moduleBlock('m', { source: str('./m'), text: passed })]);

    const graph = builder.buildExecutionGraph([], [child, root]);

    expect(graph.getNode('module.m.vars:text')).toMatchObject({ value: passed });
  });

  it('should name the module and the output when the output does not exist', () => {
    const main = resource('main', { id: ref('module', 'vars', 'missing') });

    expect(() => builder.buildExecutionGraph([main], [module([], []), module(['vars'], [])])).toThrow('module "vars" has no output "missing"');
  });

  it('should say when the module itself is not declared', () => {
    const main = resource('main', { id: ref('module', 'nope', 'o') });

    expect(() => builder.buildExecutionGraph([main], [module([], [])])).toThrow('module "nope" is not declared');
  });
});
