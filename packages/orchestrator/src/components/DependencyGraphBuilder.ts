import { ModuleAddress } from '@clay/contracts';
import { Graph } from '@clay/graph';
import { AttributeValue, callsIn, DataBlock, ModuleBlock, Position, spell, Statement } from '@clay/parser';

import { Instances, Repetition } from '../Instances';
import { Declared, declaredOf } from '../declared';
import { functionCalled } from '../functions';
import { callKey, Context, dataSourceAddress, dataSourceKey, localKey, ModuleCall, outputKey, scopeOf, variableKey } from '../keys';
import { ModuleInstances } from '../ModuleInstances';
import { placed, tryAt, withPlace } from '../place';
import { COUNT_INDEX_OUTSIDE, eachOutside, readCall, readInstance } from '../resolvers/instance';
import { Reference, ReferenceScanner } from '../resolvers/ReferenceScanner';
import { LoadedModule, LoadedResource, outputsOf } from './ModuleLoader';

/** The module as written, not an instance; a node runs once per instance. A module call sits in its caller. */
interface InModule {
  module: ModuleAddress;
}

/** `context` is where the value is read, not where it is declared: a module input is read in the call. */
export interface ValueNode extends InModule {
  name: string;
  value: AttributeValue | undefined;
  context: ModuleAddress | ModuleCall;
  position: Position;
  declaration: string;
}

/** An output always has a value; a variable may not until a call gives it one. */
export type OutputNode = ValueNode & { value: AttributeValue; declared: Declared };

export type LocalNode = ValueNode & { value: AttributeValue };

const SPELLED = { variable: 'var', local: 'local', output: 'output' };

export type GraphNode =
  | ({ kind: 'resource' } & InModule)
  | ({ kind: 'variable' } & ValueNode)
  | ({ kind: 'local' } & LocalNode)
  | ({ kind: 'output' } & OutputNode)
  | ({ kind: 'module'; block: ModuleBlock } & InModule)
  | ({ kind: 'data'; block: DataBlock } & InModule);

/** `module.m.var.x`; a resource's key already is its address. */
function spellNode(key: string, node: GraphNode): string {
  if (node.kind === 'resource') return key;
  if (node.kind === 'module') return node.module.child(node.block.name).toString();
  if (node.kind === 'data') return dataSourceAddress(node.module.toString(), node.block.dataSourceType, node.block.name);

  const scope = node.module.toString();
  return `${scope ? `${scope}.` : ''}${SPELLED[node.kind]}.${node.name}`;
}

function inputNames(attributes: Record<string, AttributeValue>): string[] {
  return Object.keys(attributes).filter((name) => name !== 'source');
}

/** `count.index` and `each.*` are valid only in a block, or a module call's inputs, with the matching repetition. */
function checkInstanceReference(reference: Extract<Reference, { kind: 'count' | 'each' }>, repetition: Repetition | undefined): void {
  if (reference.kind === 'count' && repetition !== 'count') throw placed(COUNT_INDEX_OUTSIDE, reference.position);
  if (reference.kind === 'each' && repetition !== 'for_each') throw placed(eachOutside(reference.name), reference.position);
}

function describeMissing(reference: Exclude<Reference, { kind: 'count' | 'each' }>, moduleScopes: Set<string>): string {
  if (reference.kind === 'variable') return `variable "${reference.name}" is not defined`;
  if (reference.kind === 'local') return `local "${reference.name}" is not defined`;
  if (reference.kind === 'resource') return `"${reference.key}" is not declared in the configuration`;
  // As written: the error's place names the module.
  if (reference.kind === 'data') return `"${reference.name}" is not declared in the configuration`;

  return moduleScopes.has(reference.scope) ? `module "${reference.module}" has no output "${reference.name}"` : `module "${reference.module}" is not declared`;
}

interface Dependent {
  key: string;
  declaration: string;
  context: Context;
}

type ReferencePlace = Omit<Dependent, 'key'> & { position: Position };

const edgeKey = (from: string, to: string) => `${from} -> ${to}`;

export class DependencyGraphBuilder {
  private references = new Map<string, ReferencePlace>();
  private outputs = new Map<string, string[]>();

  constructor(
    private scanner: ReferenceScanner,
    private instances: Instances,
    private modules: ModuleInstances
  ) {}

  buildExecutionGraph(loadedResources: LoadedResource[], loadedModules: LoadedModule[]): Graph<GraphNode> {
    const graph = new Graph<GraphNode>();
    this.references.clear();
    this.outputs = new Map(loadedModules.map((mod) => [scopeOf(mod.address), [...outputsOf(mod.program).keys()]]));

    for (const { uniqueId, address } of loadedResources) graph.addNode(uniqueId, { kind: 'resource', module: address.module });
    for (const [key, node] of this.valueNodes(loadedModules)) graph.addNode(key, node);

    const moduleScopes = new Set(loadedModules.map((mod) => scopeOf(mod.address)));
    for (const [key, node] of graph.entries()) this.addNodeDependencies(key, node, graph, moduleScopes);
    for (const resource of loadedResources) this.addResourceDependencies(resource, graph, moduleScopes);
    for (const [key, node] of graph.entries()) if (!node.module.isRoot()) graph.addEdge(callKey(node.module), key);

    this.refuseCycle(graph);
    return graph;
  }

  /** Reported at a reference in the cycle, so the error points at a line to change. A call's edges to its own nodes have no reference, but they alone never close a cycle. */
  private refuseCycle(graph: Graph<GraphNode>): void {
    const cycle = graph.findCycle();
    if (!cycle) return;

    const message = `Dependency cycle detected: ${cycle.map((key) => spellNode(key, graph.getNode(key)!)).join(' -> ')}`;
    for (const [i, node] of cycle.slice(0, -1).entries()) {
      const reference = this.references.get(edgeKey(cycle[i + 1], node));
      if (reference) throw withPlace(new Error(message), reference.position, reference.declaration, reference.context);
    }
  }

  private addNodeDependencies(key: string, node: GraphNode, graph: Graph<GraphNode>, moduleScopes: Set<string>): void {
    if (node.kind === 'variable' || node.kind === 'local' || node.kind === 'output') this.addValueDependencies(key, node, graph, moduleScopes);
    if (node.kind === 'module') this.addCallDependencies(key, node.block, node.module, graph, moduleScopes);
    if (node.kind === 'data') this.addDataDependencies(key, node.block, node.module, graph, moduleScopes);
  }

  private addValueDependencies(key: string, node: ValueNode, graph: Graph<GraphNode>, moduleScopes: Set<string>): void {
    const { value } = node;
    if (!value) return;

    const repetition = node.context instanceof ModuleCall ? this.modules.repetitionOf(node.module) : undefined;
    const dependent = { key, declaration: node.declaration, context: node.context };

    tryAt(node.position, node.declaration, node.context, () => this.addDependencies(value, graph, dependent, moduleScopes, repetition));
  }

  /** A call's count or for_each is read in the caller, before the module has instances. */
  private addCallDependencies(key: string, block: ModuleBlock, caller: ModuleAddress, graph: Graph<GraphNode>, moduleScopes: Set<string>): void {
    const dependent = { key, declaration: spell(block), context: caller };

    for (const value of [block.count, block.forEach])
      if (value) tryAt(value.position, dependent.declaration, caller, () => this.addDependencies(value, graph, dependent, moduleScopes));
  }

  /** As a resource's: its count or for_each is read before any instance, so it has no key. */
  private addDataDependencies(key: string, block: DataBlock, module: ModuleAddress, graph: Graph<GraphNode>, moduleScopes: Set<string>): void {
    const dependent = { key, declaration: spell(block), context: module };
    const repetition = this.instances.repetitionOf(key);

    for (const value of [block.count, block.forEach])
      if (value) tryAt(value.position, dependent.declaration, module, () => this.addDependencies(value, graph, dependent, moduleScopes));
    for (const value of Object.values(block.attributes))
      tryAt(value.position, dependent.declaration, module, () => this.addDependencies(value, graph, dependent, moduleScopes, repetition));
  }

  /** One value at a time, so an error points at the value, not the block. count and for_each are read before any instance, so they have no key. */
  private addResourceDependencies({ address, block }: LoadedResource, graph: Graph<GraphNode>, moduleScopes: Set<string>): void {
    const dependent = { key: address.toString(), declaration: spell(block), context: address };
    const repetition = this.instances.repetitionOf(dependent.key);

    for (const value of [block.count, block.forEach])
      if (value) tryAt(value.position, dependent.declaration, address, () => this.addDependencies(value, graph, dependent, moduleScopes));
    for (const value of Object.values(block.attributes))
      tryAt(value.position, dependent.declaration, address, () => this.addDependencies(value, graph, dependent, moduleScopes, repetition));
  }

  /** Looks through the variables, locals, outputs and data sources in between. */
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

  /** Variables, locals, outputs and data sources are nodes, so they run after what they read and before what reads them. */
  private valueNodes(loadedModules: LoadedModule[]): Map<string, GraphNode> {
    const nodes = new Map<string, GraphNode>();

    for (const { address, program } of loadedModules) for (const stmt of program) this.setNodes(stmt, address, nodes);

    return nodes;
  }

  private setNodes(stmt: Statement, module: ModuleAddress, nodes: Map<string, GraphNode>): void {
    const scope = scopeOf(module);
    const declaration = spell(stmt);

    if (stmt.type === 'Output')
      nodes.set(outputKey(scope, stmt.name), {
        kind: 'output',
        module,
        name: stmt.name,
        value: stmt.value,
        declared: declaredOf(stmt),
        context: module,
        position: stmt.value.position,
        declaration,
      });
    if (stmt.type === 'Variable' && !nodes.has(variableKey(scope, stmt.name)))
      nodes.set(variableKey(scope, stmt.name), {
        kind: 'variable',
        module,
        name: stmt.name,
        value: stmt.attributes.default,
        context: module,
        position: stmt.attributes.default?.position ?? stmt.position,
        declaration,
      });
    if (stmt.type === 'Local')
      nodes.set(localKey(scope, stmt.name), {
        kind: 'local',
        module,
        name: stmt.name,
        value: stmt.value,
        context: module,
        position: stmt.value.position,
        declaration,
      });
    if (stmt.type === 'Module') this.setCallNodes(stmt, nodes, module);
    if (stmt.type === 'Data') nodes.set(dataSourceKey(scope, stmt.dataSourceType, stmt.name), { kind: 'data', module, block: stmt });
  }

  // An input is read in the call and overrides the default.
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

  /** Checked here too, since the body of a for over an empty collection is never evaluated. */
  private checkCalls(value: AttributeValue): void {
    for (const call of callsIn(value)) functionCalled(call);
  }

  private addDependencies(value: AttributeValue, graph: Graph<GraphNode>, dependent: Dependent, moduleScopes: Set<string>, repetition?: Repetition): void {
    this.checkCalls(value);

    for (const reference of this.scanner.referencesIn(value, dependent.context)) {
      if (reference.kind === 'count' || reference.kind === 'each') {
        checkInstanceReference(reference, repetition);
        continue;
      }

      // With the module known to exist, its call says whether the first step must be an index.
      if (reference.kind === 'output' && moduleScopes.has(reference.scope)) readCall(reference.reference, this.modules.repetitionOf(reference.call), reference.position);

      // A string may hold several references, so the error points at the missing one.
      if (!graph.hasNode(reference.key)) throw placed(describeMissing(reference, moduleScopes), reference.position);

      // Checked here too, since a reference to a resource not yet created is never read at plan time.
      if (reference.kind === 'resource') {
        const { type, name, path } = reference.reference;
        readInstance(`${type}.${name}`, path, this.instances.repetitionOf(reference.key), reference.position);
      }

      for (const from of this.readFrom(reference)) this.addEdge(from, dependent, graph, reference.position);
    }
  }

  private addEdge(from: string, dependent: Dependent, graph: Graph<GraphNode>, position?: Position): void {
    graph.addEdge(from, dependent.key);
    const edge = edgeKey(from, dependent.key);
    if (position && !this.references.has(edge)) this.references.set(edge, { position, declaration: dependent.declaration, context: dependent.context });
  }

  /** A whole module is read once every output of it has a value. */
  private readFrom(reference: Exclude<Reference, { kind: 'count' | 'each' }>): string[] {
    if (reference.kind !== 'output' || reference.name !== undefined) return [reference.key];

    return [reference.key, ...(this.outputs.get(reference.scope) ?? []).map((name) => outputKey(reference.scope, name))];
  }
}
