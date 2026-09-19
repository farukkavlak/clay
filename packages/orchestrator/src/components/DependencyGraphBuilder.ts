import { Graph } from '@miniform/graph';
import { AttributeValue, ModuleBlock } from '@miniform/parser';

import { Address } from '../Address';
import { childScope, outputKey, variableKey } from '../keys';
import { Reference, ReferenceScanner } from '../resolvers/ReferenceScanner';
import { ScopeManager } from '../scope/ScopeManager';
import { LoadedModule, LoadedResource } from './ModuleLoader';

/** A value node carries the expression to evaluate and the address it is evaluated from. */
export interface ValueNode {
  scope: string;
  name: string;
  value: AttributeValue | undefined;
  context: Address;
}

export type GraphNode = { kind: 'resource' } | ({ kind: 'variable' } & ValueNode) | ({ kind: 'output' } & ValueNode);

function inputNames(attributes: Record<string, AttributeValue>): string[] {
  return Object.keys(attributes).filter((name) => name !== 'source');
}

function describeMissing(reference: Reference, moduleScopes: Set<string>): string {
  if (reference.kind === 'variable') return `variable "${reference.name}" is not defined`;
  if (reference.kind === 'resource') return `"${reference.address}" is not declared in the configuration`;

  return moduleScopes.has(reference.scope) ? `module "${reference.module}" has no output "${reference.name}"` : `module "${reference.module}" is not declared`;
}

export class DependencyGraphBuilder {
  constructor(
    private scopeManager: ScopeManager,
    private scanner: ReferenceScanner
  ) {}

  buildExecutionGraph(loadedResources: LoadedResource[], loadedModules: LoadedModule[]): Graph<GraphNode> {
    const graph = new Graph<GraphNode>();

    for (const { uniqueId } of loadedResources) graph.addNode(uniqueId, { kind: 'resource' });
    for (const [key, node] of this.valueNodes(loadedModules)) graph.addNode(key, node);

    const moduleScopes = new Set(loadedModules.map((mod) => this.scopeManager.getScope(mod.address)));
    for (const [key, node] of graph.entries()) if (node.kind !== 'resource') this.addDependencies(node.value, graph, key, node.context, moduleScopes);
    for (const { address, block } of loadedResources) this.addDependencies(block.attributes, graph, address.toString(), address, moduleScopes);

    return graph;
  }

  /** Variables and outputs are nodes of their own: what they read runs before them, and they run before whoever reads them. */
  private valueNodes(loadedModules: LoadedModule[]): Map<string, GraphNode> {
    const nodes = new Map<string, GraphNode>();

    for (const mod of loadedModules) {
      const scope = this.scopeManager.getScope(mod.address);

      for (const stmt of mod.program) {
        if (stmt.type === 'Output') nodes.set(outputKey(scope, stmt.name), { kind: 'output', scope, name: stmt.name, value: stmt.value, context: mod.address });
        if (stmt.type === 'Variable' && !nodes.has(variableKey(scope, stmt.name)))
          nodes.set(variableKey(scope, stmt.name), { kind: 'variable', scope, name: stmt.name, value: stmt.attributes.default, context: mod.address });
        if (stmt.type === 'Module') this.setInputNodes(stmt, nodes, scope, mod.address);
      }
    }

    return nodes;
  }

  // An input is read where the module is called, so its context is the parent, and it wins over the default inside.
  private setInputNodes(stmt: ModuleBlock, nodes: Map<string, GraphNode>, scope: string, context: Address): void {
    const child = childScope(scope, stmt.name);
    for (const name of inputNames(stmt.attributes)) nodes.set(variableKey(child, name), { kind: 'variable', scope: child, name, value: stmt.attributes[name], context });
  }

  private addDependencies(value: unknown, graph: Graph<GraphNode>, dependentKey: string, context: Address, moduleScopes: Set<string>): void {
    for (const reference of this.scanner.referencesIn(value, context)) {
      if (!graph.hasNode(reference.key)) throw new Error(`Invalid reference in "${dependentKey}": ${describeMissing(reference, moduleScopes)}`);

      graph.addEdge(reference.key, dependentKey);
    }
  }
}
