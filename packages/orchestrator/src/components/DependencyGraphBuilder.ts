import { Graph } from '@miniform/graph';

import { Address } from '../Address';
import { ReferenceScanner } from '../resolvers/ReferenceScanner';
import { ScopeManager } from '../scope/ScopeManager';
import { LoadedModule, LoadedResource } from './ModuleLoader';

export class DependencyGraphBuilder {
  constructor(
    private scopeManager: ScopeManager,
    private scanner: ReferenceScanner
  ) {}

  buildExecutionGraph(loadedResources: LoadedResource[], loadedModules: LoadedModule[]): Graph<null> {
    const graph = new Graph<null>();

    // Add all resources as nodes
    for (const { uniqueId } of loadedResources) graph.addNode(uniqueId, null);

    this.addOutputNodes(loadedModules, graph);
    this.addOutputDependencies(loadedModules, graph);

    // Add resource dependencies
    for (const { address, block } of loadedResources) this.addDependencies(block.attributes, graph, address.toString(), address);

    return graph;
  }

  private addOutputNodes(loadedModules: LoadedModule[], graph: Graph<null>): void {
    for (const mod of loadedModules) {
      const scope = this.scopeManager.getScope(mod.address);
      for (const stmt of mod.program)
        if (stmt.type === 'Output') {
          const outputKey = scope ? `${scope}.outputs.${stmt.name}` : `outputs.${stmt.name}`;
          graph.addNode(outputKey, null);
        }
    }
  }

  private addOutputDependencies(loadedModules: LoadedModule[], graph: Graph<null>): void {
    for (const mod of loadedModules) {
      const scope = this.scopeManager.getScope(mod.address);
      for (const stmt of mod.program)
        if (stmt.type === 'Output') {
          const outputKey = scope ? `${scope}.outputs.${stmt.name}` : `outputs.${stmt.name}`;
          this.addDependencies(stmt.value, graph, outputKey, mod.address);
        }
    }
  }

  private addDependencies(value: unknown, graph: Graph<null>, dependentKey: string, context: Address): void {
    for (const key of this.scanner.keysIn(value, context)) {
      if (!graph.hasNode(key)) throw new Error(`Invalid reference in "${dependentKey}": "${key}" is not declared in the configuration`);

      graph.addEdge(key, dependentKey);
    }
  }
}
