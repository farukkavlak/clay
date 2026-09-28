import { Address, ExactNumber, State } from '@clay/contracts';
import { Graph } from '@clay/graph';
import { AttributeValue, ResourceBlock, spell } from '@clay/parser';
import { DesiredResource, hasChanges, isUnknown, UNKNOWN } from '@clay/planner';
import { moveResource } from '@clay/state';

import { Instances } from '../Instances';
import { tryAt } from '../place';
import { checkInRange } from '../resolvers/instance';
import { kindOf } from '../resolvers/readPath';
import { ReferenceResolver } from '../resolvers/ReferenceResolver';
import { Reference, ReferenceScanner } from '../resolvers/ReferenceScanner';
import { UnresolvedReferenceError } from '../resolvers/UnresolvedReferenceError';
import { ScopeManager } from '../scope/ScopeManager';
import { DependencyGraphBuilder, GraphNode, ValueNode } from './DependencyGraphBuilder';
import { LoadedResource } from './ModuleLoader';

/** What the configuration asks for, with every value resolved against the state or left UNKNOWN. */
export interface DesiredState {
  resources: DesiredResource[];
  outputs: Record<string, unknown>;
}

/** A count says how many instances to make, so it is a whole number, and one the plan knows. */
function countFrom(value: unknown): number {
  if (isUnknown(value)) throw new Error('count must be known when planning: it reads a value only an apply makes');
  if (!(value instanceof ExactNumber)) throw new Error(`count is a whole number from 0, not a ${kindOf(value)}`);

  const count = value.toSafeInteger('count');
  if (count < 0) throw new Error(`count is a whole number from 0, not ${count}`);

  return count;
}

/**
 * Resolves each resource after the ones it reads from, so a value an earlier action will change is UNKNOWN, not stale.
 * `pending` holds what will change: a resource by the instance it names, so reading one that stays as it is gives its value.
 */
export class DesiredStateBuilder {
  constructor(
    private scopeManager: ScopeManager,
    private scanner: ReferenceScanner,
    private resolver: ReferenceResolver,
    private graphBuilder: DependencyGraphBuilder,
    private instances: Instances
  ) {}

  /** Moves are made in the state it is given, which a plan reads for itself and never writes, and then plans the actions against. */
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
        else resources.push(...this.planResource(key, byKey.get(key)!, graph, state, pending));
      }

    return { resources, outputs };
  }

  /** One desired resource for each instance the block makes: one with no count, and one per index with it. */
  private planResource(key: string, loaded: LoadedResource, graph: Graph<GraphNode>, state: State, pending: Set<string>): DesiredResource[] {
    const { address, block } = loaded;
    const count = block.count && this.readCount(block.count, block, address, state, pending);
    const dependencies = this.instancesOf(this.graphBuilder.resourceDependencies(graph, key));

    if (count === undefined) return [this.planInstance(address, block, dependencies, state, pending)];

    this.instances.setCount(key, count);
    return Array.from({ length: count }, (_, index) =>
      this.planInstance(new Address(address.modulePath, address.resourceType, address.name, index), block, dependencies, state, pending)
    );
  }

  private readCount(value: AttributeValue, block: ResourceBlock, address: Address, state: State, pending: Set<string>): number {
    return tryAt(value.position, spell(block), address, () => countFrom(this.resolveOrUnknown(value, state, address, pending)));
  }

  private planInstance(address: Address, block: ResourceBlock, dependencies: string[], state: State, pending: Set<string>): DesiredResource {
    const movedFrom = this.moveIn(address, state);
    const attributes = this.resolveForPlan(block, state, address, pending);
    const current = state.resources[address.toString()];
    if (!current || hasChanges(current.attributes, attributes)) pending.add(address.toString());

    return { address, block, attributes, dependencies, ...(movedFrom && { movedFrom }) };
  }

  /** Made before anything reads the instance, so a reader finds it where the configuration now names it and sees its value. */
  private moveIn(address: Address, state: State): string | undefined {
    const source = address.countCounterpart();
    if (!source || Object.hasOwn(state.resources, address.toString()) || !Object.hasOwn(state.resources, source.toString())) return undefined;

    moveResource(state, source, address);
    return source.toString();
  }

  /** The graph links blocks; state keeps what each instance read, so a delete runs after every instance of what it read from. Each block was planned before, so its count is known. */
  private instancesOf(blocks: string[]): string[] {
    return blocks.flatMap((block) => {
      const count = this.instances.countOf(block);
      if (count === undefined) return [block];

      const { modulePath, resourceType, name } = Address.parse(block);
      return Array.from({ length: count }, (_, index) => new Address(modulePath, resourceType, name, index).toString());
    });
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

  /** An index past a count is refused before anything is read, since a reference to a pending instance is never resolved. */
  private resolveOrUnknown(value: unknown, state: State, context: Address, pending: Set<string>): unknown {
    for (const reference of this.scanner.referencesIn(value, context)) {
      if (reference.kind === 'count') continue;
      if (reference.kind === 'resource') this.checkIndex(reference);
      if (pending.has(reference.kind === 'resource' ? reference.address : reference.key)) return UNKNOWN;
    }

    try {
      return this.resolver.resolveValue(value, state, context);
    } catch (error) {
      if (!(error instanceof UnresolvedReferenceError)) throw error;
      return UNKNOWN;
    }
  }

  private checkIndex({ key, reference, position }: Extract<Reference, { kind: 'resource' }>): void {
    const [first] = reference.path;
    if (typeof first === 'number' && this.instances.isCounted(key)) checkInRange(reference, first, this.instances.countOf(key), position);
  }
}
