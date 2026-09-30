import { ModuleAddress } from '@clay/contracts';
import { Graph } from '@clay/graph';
import { AttributeValue, ModuleBlock, Position, spell } from '@clay/parser';

import { Instances, Repetition } from '../Instances';
import { callKey, Context, ModuleCall, outputKey, scopeOf, variableKey } from '../keys';
import { ModuleInstances } from '../ModuleInstances';
import { placed, tryAt, withPlace } from '../place';
import { COUNT_INDEX_OUTSIDE, eachOutside, readCall, readInstance } from '../resolvers/instance';
import { Reference, ReferenceScanner } from '../resolvers/ReferenceScanner';
import { LoadedModule, LoadedResource } from './ModuleLoader';

/** Every node sits in a module, as the configuration writes it, and runs once for each instance of it; a module call sits in the module that calls it. */
interface InModule {
  module: ModuleAddress;
}

/** `context` is where the value is read, not the module that declares it: a module input is read in the call. */
export interface ValueNode extends InModule {
  name: string;
  value: AttributeValue | undefined;
  context: ModuleAddress | ModuleCall;
  position: Position;
  declaration: string;
}

export type GraphNode =
  | ({ kind: 'resource' } & InModule)
  | ({ kind: 'variable' } & ValueNode)
  | ({ kind: 'output' } & ValueNode)
  | ({ kind: 'module'; block: ModuleBlock } & InModule);

function inputNames(attributes: Record<string, AttributeValue>): string[] {
  return Object.keys(attributes).filter((name) => name !== 'source');
}

/** `count.index` and `each.key` read the instance being made, so only a block that makes instances of that kind knows them, and a module's inputs where its call does. */
function checkInstanceReference(reference: Extract<Reference, { kind: 'count' | 'each' }>, repetition: Repetition | undefined): void {
  if (reference.kind === 'count' && repetition !== 'count') throw placed(COUNT_INDEX_OUTSIDE, reference.position);
  if (reference.kind === 'each' && repetition !== 'for_each') throw placed(eachOutside(reference.name), reference.position);
}

function describeMissing(reference: Exclude<Reference, { kind: 'count' | 'each' }>, moduleScopes: Set<string>): string {
  if (reference.kind === 'variable') return `variable "${reference.name}" is not defined`;
  if (reference.kind === 'resource') return `"${reference.key}" is not declared in the configuration`;

  return moduleScopes.has(reference.scope) ? `module "${reference.module}" has no output "${reference.name}"` : `module "${reference.module}" is not declared`;
}

/** The node a value belongs to, and the block and module it is read in. */
interface Dependent {
  key: string;
  declaration: string;
  context: Context;
}

/** Where a reference that makes an edge is written. */
type ReferencePlace = Omit<Dependent, 'key'> & { position: Position };

const edgeKey = (from: string, to: string) => `${from} -> ${to}`;

export class DependencyGraphBuilder {
  private references = new Map<string, ReferencePlace>();

  constructor(
    private scanner: ReferenceScanner,
    private instances: Instances,
    private modules: ModuleInstances
  ) {}

  buildExecutionGraph(loadedResources: LoadedResource[], loadedModules: LoadedModule[]): Graph<GraphNode> {
    const graph = new Graph<GraphNode>();
    this.references.clear();

    for (const { uniqueId, address } of loadedResources) graph.addNode(uniqueId, { kind: 'resource', module: address.module });
    for (const [key, node] of this.valueNodes(loadedModules)) graph.addNode(key, node);

    const moduleScopes = new Set(loadedModules.map((mod) => scopeOf(mod.address)));
    for (const [key, node] of graph.entries()) this.addNodeDependencies(key, node, graph, moduleScopes);
    for (const resource of loadedResources) this.addResourceDependencies(resource, graph, moduleScopes);
    for (const [key, node] of graph.entries()) if (!node.module.isRoot()) graph.addEdge(callKey(node.module), key);

    this.refuseCycle(graph);
    return graph;
  }

  /** Refused at a reference in the cycle, so the error points at a line to change. An edge from a module call to its own nodes has no reference, but those edges alone never close a cycle. */
  private refuseCycle(graph: Graph<GraphNode>): void {
    const cycle = graph.findCycle();
    if (!cycle) return;

    const message = `Dependency cycle detected: ${cycle.join(' -> ')}`;
    for (const [i, node] of cycle.slice(0, -1).entries()) {
      const reference = this.references.get(edgeKey(cycle[i + 1], node));
      if (reference) throw withPlace(new Error(message), reference.position, reference.declaration, reference.context);
    }
  }

  private addNodeDependencies(key: string, node: GraphNode, graph: Graph<GraphNode>, moduleScopes: Set<string>): void {
    if (node.kind === 'variable' || node.kind === 'output') this.addValueDependencies(key, node, graph, moduleScopes);
    if (node.kind === 'module') this.addCallDependencies(key, node.block, node.module, graph, moduleScopes);
  }

  private addValueDependencies(key: string, node: ValueNode, graph: Graph<GraphNode>, moduleScopes: Set<string>): void {
    const repetition = node.context instanceof ModuleCall ? this.modules.repetitionOf(node.module) : undefined;

    const dependent = { key, declaration: node.declaration, context: node.context };

    tryAt(node.position, node.declaration, node.context, () => this.addDependencies(node.value, graph, dependent, moduleScopes, repetition));
  }

  /** A call's count or for_each is read in the module that calls it, before any instance of the module is made. */
  private addCallDependencies(key: string, block: ModuleBlock, caller: ModuleAddress, graph: Graph<GraphNode>, moduleScopes: Set<string>): void {
    const dependent = { key, declaration: spell(block), context: caller };

    for (const value of [block.count, block.forEach])
      if (value) tryAt(value.position, dependent.declaration, caller, () => this.addDependencies(value, graph, dependent, moduleScopes));
  }

  /** One value at a time, so an error points at the value that reads, not at the block it sits in. The count or for_each is read before any instance is, so it has no key. */
  private addResourceDependencies({ address, block }: LoadedResource, graph: Graph<GraphNode>, moduleScopes: Set<string>): void {
    const dependent = { key: address.toString(), declaration: spell(block), context: address };
    const repetition = this.instances.repetitionOf(dependent.key);

    for (const value of [block.count, block.forEach])
      if (value) tryAt(value.position, dependent.declaration, address, () => this.addDependencies(value, graph, dependent, moduleScopes));
    for (const value of Object.values(block.attributes))
      tryAt(value.position, dependent.declaration, address, () => this.addDependencies(value, graph, dependent, moduleScopes, repetition));
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

  // An input is read in the call, and it wins over the default inside.
  private setCallNodes(stmt: ModuleBlock, nodes: Map<string, GraphNode>, context: ModuleAddress): void {
    const module = context.child(stmt.name);
    const declaration = spell(stmt);

    nodes.set(callKey(module), { kind: 'module', module: context, block: stmt });

    for (const name of inputNames(stmt.attributes))
      nodes.set(variableKey(scopeOf(module), name), {
        kind: 'variable',
        module,
        name,
        value: stmt.attributes[name],
        context: new ModuleCall(module),
        position: stmt.attributes[name].position,
        declaration,
      });
  }

  private addDependencies(value: unknown, graph: Graph<GraphNode>, dependent: Dependent, moduleScopes: Set<string>, repetition?: Repetition): void {
    for (const reference of this.scanner.referencesIn(value, dependent.context)) {
      if (reference.kind === 'count' || reference.kind === 'each') {
        checkInstanceReference(reference, repetition);
        continue;
      }

      // Once the module is known to be there, its call says whether the first step is an index, and a wrong one is refused for what it is.
      if (reference.kind === 'output' && moduleScopes.has(reference.scope)) readCall(reference.reference, this.modules.repetitionOf(reference.call), reference.position);

      if (!graph.hasNode(reference.key)) {
        const message = `Invalid reference in "${dependent.key}": ${describeMissing(reference, moduleScopes)}`;
        // A string may hold several references, so the one missing is a closer place than the value it sits in.
        throw placed(message, reference.position);
      }

      // Checked here, as well as where it is read, since a reference to a resource still to come is never read at plan time.
      if (reference.kind === 'resource') readInstance(reference.reference, this.instances.repetitionOf(reference.key), reference.position);

      graph.addEdge(reference.key, dependent.key);
      const edge = edgeKey(reference.key, dependent.key);
      if (reference.position && !this.references.has(edge))
        this.references.set(edge, { position: reference.position, declaration: dependent.declaration, context: dependent.context });
    }
  }
}
