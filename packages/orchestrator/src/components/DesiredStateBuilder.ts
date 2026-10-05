import { Address, ModuleAddress, Output, Resource, Schema, State, UNKNOWN } from '@clay/contracts';
import { Graph } from '@clay/graph';
import { AttributeValue, ResourceBlock, spell, spellReference, Statement } from '@clay/parser';
import { DesiredResource, hasChanges } from '@clay/planner';
import { moveResource } from '@clay/state';

import { writtenAt } from '../conformValues';
import { countFrom } from '../count';
import { givenTo } from '../declared';
import { eachFrom } from '../forEach';
import { Instances } from '../Instances';
import { Context, contextIn, enclosing, scopeOf } from '../keys';
import { ModuleInstances } from '../ModuleInstances';
import { Planned } from '../Planned';
import { tryAt, withPlace } from '../place';
import { checkHasKey, checkInRange } from '../resolvers/instance';
import { ReferenceResolver } from '../resolvers/ReferenceResolver';
import { Reference, ReferenceScanner } from '../resolvers/ReferenceScanner';
import { UnresolvedReferenceError } from '../resolvers/UnresolvedReferenceError';
import { ScopeManager } from '../scope/ScopeManager';
import { Value, valueOf } from '../Value';
import { DependencyGraphBuilder, GraphNode, OutputNode, ValueNode } from './DependencyGraphBuilder';
import { LoadedResource } from './ModuleLoader';
import { ResourcePlan, ResourcePlanner } from './ResourcePlanner';

/** What the configuration asks for, with every value resolved against the state or left UNKNOWN. */
export interface DesiredState {
  resources: DesiredResource[];
  outputs: Record<string, Output>;
}

/** The deepest module both sit in: `module.a` for `module.a.module.b` and `module.a.module.c`. */
function sharedModule(one: ModuleAddress, other: ModuleAddress): ModuleAddress {
  let depth = 0;
  while (depth < one.path.length && depth < other.path.length && one.path[depth].name === other.path[depth].name) depth += 1;

  return new ModuleAddress(one.path.slice(0, depth));
}

/**
 * Resolves each resource after the ones it reads from, so a value an earlier action will change is read as the plan knows it, not stale.
 * Each node is resolved once for every instance of its module.
 * Each instance is planned by its provider. One that will be created or changed is kept in `planned` as the provider planned it, so a resource that reads it
 * reads what it will hold: a value planned as UNKNOWN only the apply makes, and any other name is refused.
 */
export class DesiredStateBuilder {
  private schemas = new Map<string, Schema>();

  constructor(
    private scopeManager: ScopeManager,
    private scanner: ReferenceScanner,
    private resolver: ReferenceResolver,
    private graphBuilder: DependencyGraphBuilder,
    private instances: Instances,
    private modules: ModuleInstances,
    private planned: Planned,
    private resourcePlanner: ResourcePlanner
  ) {}

  /** Moves are made in the state it is given, which a plan reads for itself and never writes, and then plans the actions against. The schemas say which values the provider computes. */
  async build(loadedResources: LoadedResource[], graph: Graph<GraphNode>, state: State, schemas: Map<string, Schema>): Promise<DesiredState> {
    this.planned.begin();
    this.schemas = schemas;
    const byKey = new Map(loadedResources.map((r) => [r.address.toString(), r]));
    const resources: DesiredResource[] = [];
    const outputs: Record<string, Output> = {};

    for (const layer of graph.topologicalSort())
      for (const key of layer) {
        const node = graph.getNode(key)!;

        if (node.kind === 'module') this.planCall(node, state);
        else if (node.kind === 'resource') resources.push(...(await this.planResource(key, byKey.get(key)!, graph, state)));
        else for (const instance of this.modules.of(node.module)) this.planValue(node, instance, state, outputs);
      }

    return { resources, outputs };
  }

  /** A call's count or for_each is read in each instance of the module that calls it, and makes its instances there. */
  private planCall({ module, block }: Extract<GraphNode, { kind: 'module' }>, state: State): void {
    this.modules.expandCall(module, block, (value, parse, caller) => this.readAt(value, block, caller, state, parse));
  }

  private async planResource(key: string, loaded: LoadedResource, graph: Graph<GraphNode>, state: State): Promise<DesiredResource[]> {
    const { address, block } = loaded;
    const blocks = this.graphBuilder.resourceDependencies(graph, key);

    const planned: DesiredResource[] = [];

    for (const module of this.modules.of(address.module)) {
      const dependencies = this.instancesOf(blocks, module);
      planned.push(...(await this.planBlock(new Address(module, address.resourceType, address.name), block, dependencies, state)));
    }

    return planned;
  }

  /** One desired resource for each instance the block makes in one instance of its module: one with neither count nor for_each, and one per index or key with either. */
  private async planBlock(address: Address, block: ResourceBlock, dependencies: string[], state: State): Promise<DesiredResource[]> {
    const key = address.toString();

    if (block.count) this.instances.setCount(key, this.readAt(block.count, block, address, state, countFrom));
    if (block.forEach) this.instances.setEach(key, this.readAt(block.forEach, block, address, state, eachFrom));

    const keys = this.instances.keysOf(key);
    if (keys === undefined) return [await this.planInstance(address, block, dependencies, state)];

    const planned: DesiredResource[] = [];
    for (const instance of keys) planned.push(await this.planInstance(new Address(address.module, address.resourceType, address.name, instance), block, dependencies, state));

    return planned;
  }

  /** The count or for_each, read before any instance is, so it has no key. */
  private readAt<T>(value: AttributeValue, block: Statement, context: Context, state: State, read: (value: Value) => T): T {
    return tryAt(value.position, spell(block), context, () => read(this.resolveOrUnknown(value, state, context)));
  }

  private async planInstance(address: Address, block: ResourceBlock, dependencies: string[], state: State): Promise<DesiredResource> {
    const movedFrom = tryAt(block.position, spell(block), address, () => this.moveIn(address, state));
    const current = state.resources[address.toString()];
    const change = await this.askProvider(address, block, current, this.resolveForPlan(block, state, address));
    if (!current || change.replace || hasChanges(current.attributes, change.after)) this.planned.set(address.toString(), change.after);

    return { address, block, attributes: change.config, after: change.after, replace: change.replace, dependencies, ...(movedFrom && { movedFrom }) };
  }

  private async askProvider(address: Address, block: ResourceBlock, current: Resource | undefined, attributes: Record<string, Value>): Promise<ResourcePlan> {
    try {
      return await this.resourcePlanner.plan(block.resourceType, this.schemas.get(block.resourceType) ?? {}, current, attributes);
    } catch (error) {
      throw withPlace(error, writtenAt(error, block), spell(block), address);
    }
  }

  /**
   * Made before anything reads the instance, so a reader finds it where the configuration now names it and sees its value.
   * Two places in state it may have been kept is a guess between two resources, so it is refused, not made.
   */
  private moveIn(address: Address, state: State): string | undefined {
    if (Object.hasOwn(state.resources, address.toString())) return undefined;

    const found = address.countCounterparts().filter((kept) => Object.hasOwn(state.resources, kept.toString()));
    if (found.length > 1)
      throw new Error(`"${address}" may be ${found.map((kept) => `"${kept}"`).join(' or ')} in state, from before count came or went; say which with clay state mv`);

    const [source] = found;
    if (!source) return undefined;

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

  private planValue(node: Extract<GraphNode, { kind: 'variable' | 'output' }>, instance: ModuleAddress, state: State, rootOutputs: Record<string, Output>): void {
    if (node.kind === 'variable') this.planVariable(node, instance, state);
    else this.planOutput(node, instance, state, rootOutputs);
  }

  /** Resolved and held to its type so an error in it is found at plan, though nothing reads it; a reader resolves it again where it reads it. */
  private planVariable(node: ValueNode, instance: ModuleAddress, state: State): void {
    if (node.value === undefined) return;

    const declared = this.scopeManager.getVariable(scopeOf(node.module), node.name) ?? {};
    const value = this.resolveNode(node, node.value, instance, state);
    const read = (constant: AttributeValue) => this.resolveNode(node, constant, instance, state);
    tryAt(node.position, node.declaration, contextIn(node.context, instance), () => givenTo(node.name, value, declared, read));
  }

  /** Gives an output its value, known or not yet, so the resources reading it can be planned. */
  private planOutput(node: OutputNode, instance: ModuleAddress, state: State, rootOutputs: Record<string, Output>): void {
    const value = this.resolveNode(node, node.value, instance, state);
    this.scopeManager.setOutput(instance.toString(), node.name, value);

    if (instance.isRoot()) rootOutputs[node.name] = { value: value.data, type: value.type };
  }

  /** Resolves config values with their types; what an apply has to produce first stays UNKNOWN. */
  private resolveForPlan(block: ResourceBlock, state: State, context: Context): Record<string, Value> {
    const resolved: Record<string, Value> = {};
    const declaration = spell(block);

    for (const [key, value] of Object.entries(block.attributes)) resolved[key] = tryAt(value.position, declaration, context, () => this.resolveOrUnknown(value, state, context));

    return resolved;
  }

  private resolveNode(node: ValueNode, value: AttributeValue, instance: ModuleAddress, state: State): Value {
    const context = contextIn(node.context, instance);
    return tryAt(node.position, node.declaration, context, () => this.resolveOrUnknown(value, state, context));
  }

  /** An index past a count, or a key for_each does not give, is refused before anything is read, since an instance not made yet reads as unknown rather than as missing. */
  private resolveOrUnknown(value: AttributeValue, state: State, context: Context): Value {
    for (const reference of this.scanner.referencesIn(value, context)) {
      if (reference.kind === 'count' || reference.kind === 'each') continue;
      if (reference.kind === 'resource') this.checkIndex(reference);
      if (reference.kind === 'output') this.checkCallIndex(reference);
    }

    try {
      return this.resolver.resolveValue(value, state, context);
    } catch (error) {
      if (!(error instanceof UnresolvedReferenceError)) throw error;
      return valueOf(error.type, UNKNOWN);
    }
  }

  private checkIndex({ key, block, reference, position }: Extract<Reference, { kind: 'resource' }>): void {
    const [first] = reference.path;
    const repetition = this.instances.repetitionOf(key);

    if (repetition === 'count' && typeof first === 'number') checkInRange(spellReference([reference.type, reference.name]), first, this.instances.keysOf(block)?.length, position);
    if (repetition === 'for_each' && typeof first === 'string') checkHasKey(spellReference([reference.type, reference.name]), first, this.instances.keysOf(block), position);
  }

  private checkCallIndex({ module, call, instanceKey, position }: Extract<Reference, { kind: 'output' }>): void {
    const spelled = spellReference(['module', module]);

    if (typeof instanceKey === 'number') checkInRange(spelled, instanceKey, this.modules.keysOf(call)?.length, position);
    if (typeof instanceKey === 'string') checkHasKey(spelled, instanceKey, this.modules.keysOf(call), position);
  }
}
