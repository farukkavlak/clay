import { ModuleAddress } from '@clay/contracts';
import { Graph } from '@clay/graph';
import { AttributeValue, ModuleBlock, Position, spell } from '@clay/parser';

import { Instances, Repetition } from '../Instances';
import { callKey, Context, outputKey, scopeOf, variableKey } from '../keys';
import { placed, tryAt } from '../place';
import { readInstance } from '../resolvers/instance';
import { Reference, ReferenceScanner } from '../resolvers/ReferenceScanner';
import { LoadedModule, LoadedResource } from './ModuleLoader';

/** Every node sits in a module, as the configuration writes it, and runs once for each instance of it; a module call sits in the module that calls it. */
interface InModule {
  module: ModuleAddress;
}

/** `context` is the module that reads the value, not the one that declares it: a module input is read where the module is called. */
export interface ValueNode extends InModule {
  name: string;
  value: AttributeValue | undefined;
  context: ModuleAddress;
  position: Position;
  declaration: string;
}

export type GraphNode = ({ kind: 'resource' } & InModule) | ({ kind: 'variable' } & ValueNode) | ({ kind: 'output' } & ValueNode) | ({ kind: 'module'; name: string } & InModule);

function inputNames(attributes: Record<string, AttributeValue>): string[] {
  return Object.keys(attributes).filter((name) => name !== 'source');
}

/** `count.index` and `each.key` read the instance being made, so only a block that makes instances of that kind knows them. */
function checkInstanceReference(reference: Extract<Reference, { kind: 'count' | 'each' }>, repetition: Repetition | undefined): void {
  if (reference.kind === 'count' && repetition !== 'count') throw placed('count.index is only known inside a resource that has count', reference.position);
  if (reference.kind === 'each' && repetition !== 'for_each') throw placed(`each.${reference.name} is only known inside a resource that has for_each`, reference.position);
}

function describeMissing(reference: Exclude<Reference, { kind: 'count' | 'each' }>, moduleScopes: Set<string>): string {
  if (reference.kind === 'variable') return `variable "${reference.name}" is not defined`;
  if (reference.kind === 'resource') return `"${reference.key}" is not declared in the configuration`;

  return moduleScopes.has(reference.scope) ? `module "${reference.module}" has no output "${reference.name}"` : `module "${reference.module}" is not declared`;
}

export class DependencyGraphBuilder {
  constructor(
    private scanner: ReferenceScanner,
    private instances: Instances
  ) {}

  buildExecutionGraph(loadedResources: LoadedResource[], loadedModules: LoadedModule[]): Graph<GraphNode> {
    const graph = new Graph<GraphNode>();

    for (const { uniqueId, address } of loadedResources) graph.addNode(uniqueId, { kind: 'resource', module: address.module });
    for (const [key, node] of this.valueNodes(loadedModules)) graph.addNode(key, node);

    const moduleScopes = new Set(loadedModules.map((mod) => scopeOf(mod.address)));
    for (const [key, node] of graph.entries())
      if (node.kind === 'variable' || node.kind === 'output')
        tryAt(node.position, node.declaration, node.context, () => this.addDependencies(node.value, graph, key, node.context, moduleScopes));
    for (const resource of loadedResources) this.addResourceDependencies(resource, graph, moduleScopes);
    for (const [key, node] of graph.entries()) if (!node.module.isRoot()) graph.addEdge(callKey(node.module), key);

    return graph;
  }

  /** One value at a time, so an error points at the value that reads, not at the block it sits in. The count or for_each is read before any instance is, so it has no key. */
  private addResourceDependencies({ address, block }: LoadedResource, graph: Graph<GraphNode>, moduleScopes: Set<string>): void {
    const key = address.toString();
    const repetition = this.instances.repetitionOf(key);

    for (const value of [block.count, block.forEach]) if (value) tryAt(value.position, spell(block), address, () => this.addDependencies(value, graph, key, address, moduleScopes));
    for (const value of Object.values(block.attributes))
      tryAt(value.position, spell(block), address, () => this.addDependencies(value, graph, key, address, moduleScopes, repetition));
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
            module: mod.address,
            name: stmt.name,
            value: stmt.value,
            context: mod.address,
            position: stmt.value.position,
            declaration,
          });
        if (stmt.type === 'Variable' && !nodes.has(variableKey(scope, stmt.name)))
          nodes.set(variableKey(scope, stmt.name), {
            kind: 'variable',
            module: mod.address,
            name: stmt.name,
            value: stmt.attributes.default,
            context: mod.address,
            position: stmt.attributes.default?.position ?? stmt.position,
            declaration,
          });
        if (stmt.type === 'Module') this.setCallNodes(stmt, nodes, mod.address);
      }
    }

    return nodes;
  }

  // An input is read where the module is called, so its context is the parent, and it wins over the default inside.
  private setCallNodes(stmt: ModuleBlock, nodes: Map<string, GraphNode>, context: ModuleAddress): void {
    const module = context.child(stmt.name);
    const declaration = spell(stmt);

    nodes.set(callKey(module), { kind: 'module', module: context, name: stmt.name });

    for (const name of inputNames(stmt.attributes))
      nodes.set(variableKey(scopeOf(module), name), {
        kind: 'variable',
        module,
        name,
        value: stmt.attributes[name],
        context,
        position: stmt.attributes[name].position,
        declaration,
      });
  }

  private addDependencies(value: unknown, graph: Graph<GraphNode>, dependentKey: string, context: Context, moduleScopes: Set<string>, repetition?: Repetition): void {
    for (const reference of this.scanner.referencesIn(value, context)) {
      if (reference.kind === 'count' || reference.kind === 'each') {
        checkInstanceReference(reference, repetition);
        continue;
      }

      if (!graph.hasNode(reference.key)) {
        const message = `Invalid reference in "${dependentKey}": ${describeMissing(reference, moduleScopes)}`;
        // A string may hold several references, so the one missing is a closer place than the value it sits in.
        throw placed(message, reference.position);
      }

      // Checked here, as well as where it is read, since a reference to a resource still to come is never read at plan time.
      if (reference.kind === 'resource') readInstance(reference.reference, this.instances.repetitionOf(reference.key), reference.position);

      graph.addEdge(reference.key, dependentKey);
    }
  }
}
