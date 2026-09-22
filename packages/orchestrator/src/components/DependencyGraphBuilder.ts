import { Address } from '@clay/contracts';
import { Graph } from '@clay/graph';
import { AttributeValue, ModuleBlock, Position, spell } from '@clay/parser';

import { childScope, outputKey, scopeOf, variableKey } from '../keys';
import { tryAt } from '../place';
import { Reference, ReferenceScanner } from '../resolvers/ReferenceScanner';
import { LoadedModule, LoadedResource } from './ModuleLoader';

/** `context` is the module that reads the value, not the one that declares it: a module input is read where the module is called. */
export interface ValueNode {
  scope: string;
  name: string;
  value: AttributeValue | undefined;
  context: Address;
  position: Position;
  declaration: string;
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
  constructor(private scanner: ReferenceScanner) {}

  buildExecutionGraph(loadedResources: LoadedResource[], loadedModules: LoadedModule[]): Graph<GraphNode> {
    const graph = new Graph<GraphNode>();

    for (const { uniqueId } of loadedResources) graph.addNode(uniqueId, { kind: 'resource' });
    for (const [key, node] of this.valueNodes(loadedModules)) graph.addNode(key, node);

    const moduleScopes = new Set(loadedModules.map((mod) => scopeOf(mod.address)));
    for (const [key, node] of graph.entries())
      if (node.kind !== 'resource') tryAt(node.position, node.declaration, node.context, () => this.addDependencies(node.value, graph, key, node.context, moduleScopes));
    // One attribute at a time, so an error points at the value that reads, not at the block it sits in.
    for (const { address, block } of loadedResources)
      for (const value of Object.values(block.attributes))
        tryAt(value.position, spell(block), address, () => this.addDependencies(value, graph, address.toString(), address, moduleScopes));

    return graph;
  }

  /** The resources a resource reads from, looking through the variables and outputs in between. */
  resourceDependencies(graph: Graph<GraphNode>, key: string): string[] {
    const found = new Set<string>();
    const seen = new Set<string>([key]);
    const queue = [key];

    for (let next = queue.shift(); next !== undefined; next = queue.shift())
      for (const dependency of graph.dependenciesOf(next)) {
        if (seen.has(dependency)) continue;
        seen.add(dependency);

        if (graph.getNode(dependency)!.kind === 'resource') found.add(dependency);
        else queue.push(dependency);
      }

    return [...found].sort();
  }

  /** Variables and outputs are nodes of their own: what they read runs before them, and they run before whoever reads them. */
  private valueNodes(loadedModules: LoadedModule[]): Map<string, GraphNode> {
    const nodes = new Map<string, GraphNode>();

    for (const mod of loadedModules) {
      const scope = scopeOf(mod.address);

      for (const stmt of mod.program) {
        const declaration = spell(stmt);

        if (stmt.type === 'Output')
          nodes.set(outputKey(scope, stmt.name), {
            kind: 'output',
            scope,
            name: stmt.name,
            value: stmt.value,
            context: mod.address,
            position: stmt.value.position,
            declaration,
          });
        if (stmt.type === 'Variable' && !nodes.has(variableKey(scope, stmt.name)))
          nodes.set(variableKey(scope, stmt.name), {
            kind: 'variable',
            scope,
            name: stmt.name,
            value: stmt.attributes.default,
            context: mod.address,
            position: stmt.attributes.default?.position ?? stmt.position,
            declaration,
          });
        if (stmt.type === 'Module') this.setInputNodes(stmt, nodes, scope, mod.address);
      }
    }

    return nodes;
  }

  // An input is read where the module is called, so its context is the parent, and it wins over the default inside.
  private setInputNodes(stmt: ModuleBlock, nodes: Map<string, GraphNode>, scope: string, context: Address): void {
    const child = childScope(scope, stmt.name);
    const declaration = spell(stmt);

    for (const name of inputNames(stmt.attributes))
      nodes.set(variableKey(child, name), {
        kind: 'variable',
        scope: child,
        name,
        value: stmt.attributes[name],
        context,
        position: stmt.attributes[name].position,
        declaration,
      });
  }

  private addDependencies(value: unknown, graph: Graph<GraphNode>, dependentKey: string, context: Address, moduleScopes: Set<string>): void {
    for (const reference of this.scanner.referencesIn(value, context)) {
      if (!graph.hasNode(reference.key)) throw new Error(`Invalid reference in "${dependentKey}": ${describeMissing(reference, moduleScopes)}`);

      graph.addEdge(reference.key, dependentKey);
    }
  }
}
