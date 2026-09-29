import { Address, ModuleAddress, State } from '@clay/contracts';
import { Graph } from '@clay/graph';
import { AttributeValue, ResourceBlock, spell, spellReference, Statement } from '@clay/parser';
import { DesiredResource, hasChanges, isUnknown, UNKNOWN } from '@clay/planner';
import { moveResource } from '@clay/state';

import { countFrom, indexesOf } from '../count';
import { eachFrom } from '../forEach';
import { Instances } from '../Instances';
import { Context, contextIn, enclosing, outputKey, variableKey } from '../keys';
import { ModuleInstances } from '../ModuleInstances';
import { tryAt } from '../place';
import { checkHasKey, checkInRange } from '../resolvers/instance';
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

/** The deepest module both sit in: `module.a` for `module.a.module.b` and `module.a.module.c`. */
function sharedModule(one: ModuleAddress, other: ModuleAddress): ModuleAddress {
  let depth = 0;
  while (depth < one.path.length && depth < other.path.length && one.path[depth].name === other.path[depth].name) depth += 1;

  return new ModuleAddress(one.path.slice(0, depth));
}

/**
 * Resolves each resource after the ones it reads from, so a value an earlier action will change is UNKNOWN, not stale.
 * Each node is resolved once for every instance of its module.
 * `pending` holds what will change: a resource by the instance it names, so reading one that stays as it is gives its value, and a variable or an output by the instance of its module.
 */
export class DesiredStateBuilder {
  constructor(
    private scopeManager: ScopeManager,
    private scanner: ReferenceScanner,
    private resolver: ReferenceResolver,
    private graphBuilder: DependencyGraphBuilder,
    private instances: Instances,
    private modules: ModuleInstances
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

        if (node.kind === 'module') this.planCall(node, state, pending);
        else if (node.kind === 'resource') resources.push(...this.planResource(key, byKey.get(key)!, graph, state, pending));
        else for (const instance of this.modules.of(node.module)) this.planValue(node, instance, state, pending, outputs);
      }

    return { resources, outputs };
  }

  /** A call's count is read in each instance of the module that calls it, and makes that many instances of the module there. */
  private planCall({ module, block }: Extract<GraphNode, { kind: 'module' }>, state: State, pending: Set<string>): void {
    const { count } = block;

    this.modules.expand(module, block.name, (caller) => (count === undefined ? undefined : indexesOf(this.readAt(count, block, caller, state, pending, countFrom))));
  }

  private planResource(key: string, loaded: LoadedResource, graph: Graph<GraphNode>, state: State, pending: Set<string>): DesiredResource[] {
    const { address, block } = loaded;
    const blocks = this.graphBuilder.resourceDependencies(graph, key);

    return this.modules.of(address.module).flatMap((module) => {
      const dependencies = this.instancesOf(blocks, module);
      return this.planBlock(new Address(module, address.resourceType, address.name), block, dependencies, state, pending);
    });
  }

  /** One desired resource for each instance the block makes in one instance of its module: one with neither count nor for_each, and one per index or key with either. */
  private planBlock(address: Address, block: ResourceBlock, dependencies: string[], state: State, pending: Set<string>): DesiredResource[] {
    const key = address.toString();

    if (block.count) this.instances.setCount(key, this.readAt(block.count, block, address, state, pending, countFrom));
    if (block.forEach) this.instances.setEach(key, this.readAt(block.forEach, block, address, state, pending, eachFrom));

    const keys = this.instances.keysOf(key);
    if (keys === undefined) return [this.planInstance(address, block, dependencies, state, pending)];

    return keys.map((instance) => this.planInstance(new Address(address.module, address.resourceType, address.name, instance), block, dependencies, state, pending));
  }

  /** The count or for_each, read before any instance is, so it has no key. */
  private readAt<T>(value: AttributeValue, block: Statement, context: Context, state: State, pending: Set<string>, read: (value: unknown) => T): T {
    return tryAt(value.position, spell(block), context, () => read(this.resolveOrUnknown(value, state, context, pending)));
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

  /**
   * The graph links blocks; state keeps what each instance read, so a delete runs after every instance of what it read from. Each block was planned before, so its keys are known.
   * Only the instances in the same instance of the module both sit in as `reader`: `module.a[0]` reads from `module.a[0]`, never from `module.a[1]`.
   */
  private instancesOf(blocks: string[], reader: ModuleAddress): string[] {
    return blocks.flatMap((block) => {
      const { module, resourceType, name } = Address.parse(block);
      const shared = sharedModule(module, reader.withoutKeys());
      const readerIn = enclosing(reader, shared).toString();

      return this.modules
        .of(module)
        .filter((instance) => enclosing(instance, shared).toString() === readerIn)
        .flatMap((instance) => this.instancesIn(new Address(instance, resourceType, name)));
    });
  }

  private instancesIn(block: Address): string[] {
    const keys = this.instances.keysOf(block.toString());
    if (keys === undefined) return [block.toString()];

    return keys.map((key) => new Address(block.module, block.resourceType, block.name, key).toString());
  }

  private planValue(node: ValueNode & { kind: 'variable' | 'output' }, instance: ModuleAddress, state: State, pending: Set<string>, rootOutputs: Record<string, unknown>): void {
    if (node.kind === 'variable') this.planVariable(node, instance, state, pending);
    else this.planOutput(node, instance, state, pending, rootOutputs);
  }

  /** A variable fed by a pending resource is pending itself, so everything reading it plans against UNKNOWN. */
  private planVariable(node: ValueNode, instance: ModuleAddress, state: State, pending: Set<string>): void {
    if (node.value !== undefined && isUnknown(this.resolveNode(node, instance, state, pending))) pending.add(variableKey(instance.toString(), node.name));
  }

  /** Gives an output its value so the resources reading it can be planned; an output fed by a pending resource keeps none. */
  private planOutput(node: ValueNode, instance: ModuleAddress, state: State, pending: Set<string>, rootOutputs: Record<string, unknown>): void {
    const value = this.resolveNode(node, instance, state, pending);
    if (isUnknown(value)) pending.add(outputKey(instance.toString(), node.name));
    else this.scopeManager.setOutput(instance.toString(), node.name, value);

    if (instance.isRoot()) rootOutputs[node.name] = value;
  }

  /** Resolves config values the way the diff needs them; what an apply has to produce first stays UNKNOWN. */
  private resolveForPlan(block: ResourceBlock, state: State, context: Context, pending: Set<string>): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};
    const declaration = spell(block);

    for (const [key, value] of Object.entries(block.attributes))
      resolved[key] = tryAt(value.position, declaration, context, () => this.resolveOrUnknown(value, state, context, pending));

    return resolved;
  }

  private resolveNode(node: ValueNode, instance: ModuleAddress, state: State, pending: Set<string>): unknown {
    const context = contextIn(node.context, instance);
    return tryAt(node.position, node.declaration, context, () => this.resolveOrUnknown(node.value, state, context, pending));
  }

  /** An index past a count, or a key for_each does not give, is refused before anything is read, since a reference to a pending instance is never resolved. */
  private resolveOrUnknown(value: unknown, state: State, context: Context, pending: Set<string>): unknown {
    for (const reference of this.scanner.referencesIn(value, context)) {
      if (reference.kind === 'count' || reference.kind === 'each') continue;
      if (reference.kind === 'resource') this.checkIndex(reference);
      if (reference.kind === 'output') this.checkCallIndex(reference);
      if (pending.has(reference.kind === 'variable' ? reference.key : reference.address)) return UNKNOWN;
    }

    try {
      return this.resolver.resolveValue(value, state, context);
    } catch (error) {
      if (!(error instanceof UnresolvedReferenceError)) throw error;
      return UNKNOWN;
    }
  }

  private checkIndex({ key, block, reference, position }: Extract<Reference, { kind: 'resource' }>): void {
    const [first] = reference.path;
    const repetition = this.instances.repetitionOf(key);

    if (repetition === 'count' && typeof first === 'number') checkInRange(spellReference([reference.type, reference.name]), first, this.instances.keysOf(block)?.length, position);
    if (repetition === 'for_each' && typeof first === 'string') checkHasKey(spellReference([reference.type, reference.name]), first, this.instances.keysOf(block), position);
  }

  private checkCallIndex({ module, call, index, position }: Extract<Reference, { kind: 'output' }>): void {
    if (typeof index === 'number') checkInRange(spellReference(['module', module]), index, this.modules.keysOf(call)?.length, position);
  }
}
