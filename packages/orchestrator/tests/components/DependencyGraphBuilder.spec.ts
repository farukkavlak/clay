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
});
