import { Statement } from '@clay/parser';
import { describe, expect, it } from 'vitest';

import { Address } from '../../src/Address';
import { DependencyGraphBuilder } from '../../src/components/DependencyGraphBuilder';
import { LoadedModule, LoadedResource } from '../../src/components/ModuleLoader';
import { ReferenceScanner } from '../../src/resolvers/ReferenceScanner';
import { ScopeManager } from '../../src/scope/ScopeManager';

function resource(name: string, attributes: Record<string, unknown> = {}, modulePath: string[] = []): LoadedResource {
  const address = new Address(modulePath, 'resource', name);
  return {
    uniqueId: address.toString(),
    address,
    block: { type: 'Resource', resourceType: 'resource', name, attributes },
  } as LoadedResource;
}

const reference = (...parts: string[]) => ({ type: 'Reference' as const, value: parts });

function module(modulePath: string[], program: Statement[]): LoadedModule {
  return { address: new Address(modulePath, '', ''), program };
}

describe('DependencyGraphBuilder', () => {
  const scopeManager = new ScopeManager();
  const builder = new DependencyGraphBuilder(scopeManager, new ReferenceScanner(scopeManager));

  it('should run a resource after the one it reads from', () => {
    const main = resource('main', { id: { type: 'Reference', value: ['resource', 'dep', 'id'] } });

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

    expect(graph.topologicalSort()).toEqual([['module.app.resource.instance'], ['module.app.outputs.ip']]);
  });

  it('should reject a reference to a resource the config does not declare', () => {
    const main = resource('main', { id: { type: 'Reference', value: ['resource', 'typo', 'id'] } });

    expect(() => builder.buildExecutionGraph([main], [])).toThrow('"resource.typo" is not declared in the configuration');
  });

  it('should run a variable after the resource its default reads', () => {
    const root = module([], [{ type: 'Variable', name: 'id', attributes: { default: reference('resource', 'dep', 'id') } }]);

    const graph = builder.buildExecutionGraph([resource('dep')], [root]);

    expect(graph.topologicalSort()).toEqual([['resource.dep'], ['vars.id']]);
  });

  it('should read a module input where the module is called and hand it to the resource inside', () => {
    const root = module([], [{ type: 'Module', name: 'm', attributes: { source: { type: 'String', value: './m' }, text: reference('resource', 'dep', 'id') } }]);
    const child = module(['m'], []);
    const inner = resource('inner', { content: reference('var', 'text') }, ['m']);

    const graph = builder.buildExecutionGraph([resource('dep'), inner], [root, child]);

    expect(graph.topologicalSort()).toEqual([['resource.dep'], ['module.m.vars.text'], ['module.m.resource.inner']]);
    expect(graph.getNode('module.m.vars.text')).toMatchObject({ kind: 'variable', context: root.address });
  });

  it('should list the resources a resource reads from, looking through a module input', () => {
    const root = module([], [{ type: 'Module', name: 'm', attributes: { source: { type: 'String', value: './m' }, text: reference('resource', 'dep', 'id') } }]);
    const child = module(['m'], []);
    const inner = resource('inner', { content: reference('var', 'text'), other: reference('resource', 'peer', 'id') }, ['m']);

    const graph = builder.buildExecutionGraph([resource('dep'), resource('peer', {}, ['m']), inner], [root, child]);

    expect(builder.resourceDependencies(graph, 'module.m.resource.inner')).toEqual(['module.m.resource.peer', 'resource.dep']);
    expect(builder.resourceDependencies(graph, 'resource.dep')).toEqual([]);
  });

  it('should let the input passed to a module win over the default declared inside it', () => {
    const passed = { type: 'String' as const, value: 'passed' };
    const declared = { type: 'String' as const, value: 'declared' };
    const child = module(['m'], [{ type: 'Variable', name: 'text', attributes: { default: declared } }]);
    const root = module([], [{ type: 'Module', name: 'm', attributes: { source: { type: 'String', value: './m' }, text: passed } }]);

    const graph = builder.buildExecutionGraph([], [child, root]);

    expect(graph.getNode('module.m.vars.text')).toMatchObject({ value: passed });
  });

  it('should name the module and the output when the output does not exist', () => {
    const main = resource('main', { id: reference('module', 'vars', 'missing') });

    expect(() => builder.buildExecutionGraph([main], [module([], []), module(['vars'], [])])).toThrow('module "vars" has no output "missing"');
  });

  it('should say when the module itself is not declared', () => {
    const main = resource('main', { id: reference('module', 'nope', 'o') });

    expect(() => builder.buildExecutionGraph([main], [module([], [])])).toThrow('module "nope" is not declared');
  });
});
