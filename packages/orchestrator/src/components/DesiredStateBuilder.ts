import { Address, State } from '@clay/contracts';
import { Graph } from '@clay/graph';
import { ResourceBlock, spell } from '@clay/parser';
import { DesiredResource, hasChanges, isUnknown, UNKNOWN } from '@clay/planner';

import { tryAt } from '../place';
import { ReferenceResolver } from '../resolvers/ReferenceResolver';
import { ReferenceScanner } from '../resolvers/ReferenceScanner';
import { UnresolvedReferenceError } from '../resolvers/UnresolvedReferenceError';
import { ScopeManager } from '../scope/ScopeManager';
import { DependencyGraphBuilder, GraphNode, ValueNode } from './DependencyGraphBuilder';
import { LoadedResource } from './ModuleLoader';

/** What the configuration asks for, with every value resolved against the state or left UNKNOWN. */
export interface DesiredState {
  resources: DesiredResource[];
  outputs: Record<string, unknown>;
}

/** Resolves each resource after the ones it reads from, so a value an earlier action will change is UNKNOWN, not stale. */
export class DesiredStateBuilder {
  constructor(
    private scopeManager: ScopeManager,
    private scanner: ReferenceScanner,
    private resolver: ReferenceResolver,
    private graphBuilder: DependencyGraphBuilder
  ) {}

  build(loadedResources: LoadedResource[], graph: Graph<GraphNode>, state: State): DesiredState {
    const byKey = new Map(loadedResources.map((r) => [r.address.toString(), r]));
    const pending = new Set<string>();
    const resources: DesiredResource[] = [];
    const outputs: Record<string, unknown> = {};

    for (const layer of graph.topologicalSort())
      for (const key of layer) {
        const node = graph.getNode(key)!;

        if (node.kind === 'variable') this.planVariable(key, node, state, pending);
        else if (node.kind === 'output') this.planOutput(key, node, state, pending, outputs);
        else resources.push(this.planResource(key, byKey.get(key)!, graph, state, pending));
      }

    return { resources, outputs };
  }

  private planResource(key: string, loaded: LoadedResource, graph: Graph<GraphNode>, state: State, pending: Set<string>): DesiredResource {
    const attributes = this.resolveForPlan(loaded.block, state, loaded.address, pending);
    const current = state.resources[key];
    if (!current || hasChanges(current.attributes, attributes)) pending.add(key);

    return { address: loaded.address, block: loaded.block, attributes, dependencies: this.graphBuilder.resourceDependencies(graph, key) };
  }

  /** A variable fed by a pending resource is pending itself, so everything reading it plans against UNKNOWN. */
  private planVariable(key: string, node: ValueNode, state: State, pending: Set<string>): void {
    if (node.value !== undefined && isUnknown(this.resolveNode(node, state, pending))) pending.add(key);
  }

  /** Gives an output its value so the resources reading it can be planned; an output fed by a pending resource keeps none. */
  private planOutput(key: string, node: ValueNode, state: State, pending: Set<string>, rootOutputs: Record<string, unknown>): void {
    const value = this.resolveNode(node, state, pending);
    if (isUnknown(value)) pending.add(key);
    else this.scopeManager.setOutput(node.scope, node.name, value);

    if (node.context.modulePath.length === 0) rootOutputs[node.name] = value;
  }

  /** Resolves config values the way the diff needs them; what an apply has to produce first stays UNKNOWN. */
  private resolveForPlan(block: ResourceBlock, state: State, context: Address, pending: Set<string>): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};
    const declaration = spell(block);

    for (const [key, value] of Object.entries(block.attributes))
      resolved[key] = tryAt(value.position, declaration, context, () => this.resolveOrUnknown(value, state, context, pending));

    return resolved;
  }

  private resolveNode(node: ValueNode, state: State, pending: Set<string>): unknown {
    return tryAt(node.position, node.declaration, node.context, () => this.resolveOrUnknown(node.value, state, node.context, pending));
  }

  private resolveOrUnknown(value: unknown, state: State, context: Address, pending: Set<string>): unknown {
    if (this.scanner.referencesIn(value, context).some((reference) => pending.has(reference.key))) return UNKNOWN;

    try {
      return this.resolver.resolveValue(value, state, context);
    } catch (error) {
      if (!(error instanceof UnresolvedReferenceError)) throw error;
      return UNKNOWN;
    }
  }
}
