import { Address, ModuleAddress, Output, Resource, Schema, State, UNKNOWN } from '@clay/contracts';
import { Graph } from '@clay/graph';
import { AttributeValue, DataBlock, ResourceBlock, spell, spellReference, Statement } from '@clay/parser';
import { DesiredResource, hasChanges } from '@clay/planner';
import { moveResource } from '@clay/state';

import { writtenAt } from '../conformValues';
import { countFrom } from '../count';
import { givenTo } from '../declared';
import { eachFrom } from '../forEach';
import { Instances } from '../Instances';
import { Context, contextIn, dataSourceAddress, enclosing, scopeOf } from '../keys';
import { ModuleInstances } from '../ModuleInstances';
import { Planned } from '../Planned';
import { tryAt, withPlace } from '../place';
import { checkHasKey, checkInRange, instanceKeyIn } from '../resolvers/instance';
import { ReferenceResolver } from '../resolvers/ReferenceResolver';
import { Reference, ReferenceScanner } from '../resolvers/ReferenceScanner';
import { UnresolvedReferenceError } from '../resolvers/UnresolvedReferenceError';
import { ScopeManager } from '../scope/ScopeManager';
import { carried, Value, valueOf } from '../Value';
import { DataSourceReader } from './DataSourceReader';
import { DependencyGraphBuilder, GraphNode, OutputNode, ValueNode } from './DependencyGraphBuilder';
import { LoadedResource } from './ModuleLoader';
import { ResourcePlan, ResourcePlanner } from './ResourcePlanner';

export interface DesiredState {
  resources: DesiredResource[];
  outputs: Record<string, Output>;
  /** What each data source read at plan gave, by address. */
  dataSources: Record<string, Record<string, Output>>;
  /** Data sources that wait for the apply, since what they read changes in it. */
  readAtApply: string[];
}

/** `module.a` for `module.a.module.b` and `module.a.module.c`. */
function sharedModule(one: ModuleAddress, other: ModuleAddress): ModuleAddress {
  let depth = 0;
  while (depth < one.path.length && depth < other.path.length && one.path[depth].name === other.path[depth].name) depth += 1;

  return new ModuleAddress(one.path.slice(0, depth));
}

/**
 * Resolves resources in dependency order, once per module instance, so a reader sees what the plan will make, not stale state.
 * Each created or changed instance is stored in `planned` as its provider planned it; a reader gets those values, UNKNOWN included.
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
    private resourcePlanner: ResourcePlanner,
    private reader: DataSourceReader
  ) {}

  /** Applies count moves to `state`, a copy the plan never writes, and plans the actions against it. */
  async build(loadedResources: LoadedResource[], graph: Graph<GraphNode>, state: State, schemas: Map<string, Schema>): Promise<DesiredState> {
    this.planned.begin();
    this.schemas = schemas;
    const byKey = new Map(loadedResources.map((r) => [r.address.toString(), r]));
    const resources: DesiredResource[] = [];
    const desired: DesiredState = { resources, outputs: {}, dataSources: {}, readAtApply: [] };

    for (const layer of graph.topologicalSort())
      for (const key of layer) {
        const node = graph.getNode(key)!;

        switch (node.kind) {
          case 'module': {
            this.planCall(node, state);
            break;
          }
          case 'resource': {
            resources.push(...(await this.planResource(key, byKey.get(key)!, graph, state)));
            break;
          }
          case 'data': {
            await this.planData(key, node, graph, state, desired);
            break;
          }
          default: {
            for (const instance of this.modules.of(node.module)) this.planValue(node, instance, state, desired.outputs);
          }
        }
      }

    return desired;
  }

  /** A module with a data source has one instance, since a repeated one is refused at load. */
  private async planData(key: string, { module, block }: Extract<GraphNode, { kind: 'data' }>, graph: Graph<GraphNode>, state: State, desired: DesiredState): Promise<void> {
    const inputs = this.resolveInputs(block, state, module);
    const address = dataSourceAddress(scopeOf(module), block.dataSourceType, block.name);

    if (this.waitsForApply(key, graph, module)) {
      this.reader.defer(block, inputs, module);
      desired.readAtApply.push(address);
    } else desired.dataSources[address] = carried(await this.reader.read(block, inputs, module));
  }

  /**
   * Read now, it would see the world before the apply changes a resource it reads, even through a variable or an output.
   * A value not known yet comes only from such a change, so its inputs are known whenever it is read now.
   */
  private waitsForApply(key: string, graph: Graph<GraphNode>, module: ModuleAddress): boolean {
    return this.instancesOf(this.graphBuilder.resourceDependencies(graph, key), module).some((instance) => this.planned.get(instance) !== undefined);
  }

  /** One value at a time, so an error points at the value, not the block. */
  private resolveInputs(block: DataBlock, state: State, module: ModuleAddress): Record<string, Value> {
    const declaration = spell(block);

    return Object.fromEntries(
      Object.entries(block.attributes).map(([name, value]) => [name, tryAt(value.position, declaration, module, () => this.resolveOrUnknown(value, state, module))])
    );
  }

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

  /** For count and for_each, read before any instance exists. */
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
   * Moves the instance before anything reads it, so readers find it at its new address.
   * Two possible old addresses would be a guess, so that is refused.
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
   * The graph links blocks, but state records instances, so a delete can run after every instance it read from.
   * Only instances in the reader's own module instance: `module.a[0]` reads from `module.a[0]`, never `module.a[1]`.
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

  /** Resolved so an error is found at plan even if nothing reads it; each reader resolves it again. */
  private planVariable(node: ValueNode, instance: ModuleAddress, state: State): void {
    if (node.value === undefined) return;

    const declared = this.scopeManager.getVariable(scopeOf(node.module), node.name) ?? {};
    const value = this.resolveNode(node, node.value, instance, state);
    const read = (constant: AttributeValue) => this.resolveNode(node, constant, instance, state);
    tryAt(node.position, node.declaration, contextIn(node.context, instance), () => givenTo('variable', node.name, value, declared, read));
  }

  private planOutput(node: OutputNode, instance: ModuleAddress, state: State, rootOutputs: Record<string, Output>): void {
    const read = (constant: AttributeValue) => this.resolveNode(node, constant, instance, state);
    const resolved = this.resolveNode(node, node.value, instance, state);
    const value = tryAt(node.position, node.declaration, contextIn(node.context, instance), () => givenTo('output', node.name, resolved, node.declared, read));
    this.scopeManager.setOutput(instance.toString(), node.name, value);

    if (instance.isRoot()) rootOutputs[node.name] = { value: value.data, type: value.type };
  }

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

  /** A bad index or key is refused first, since an instance not made yet would read as unknown, not missing. */
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
    const first = instanceKeyIn(reference.path);
    const repetition = this.instances.repetitionOf(key);
    const spelled = spellReference([{ name: reference.type }, { name: reference.name }]);

    if (repetition === 'count' && typeof first === 'number') checkInRange(spelled, first, this.instances.keysOf(block)?.length, position);
    if (repetition === 'for_each' && typeof first === 'string') checkHasKey(spelled, first, this.instances.keysOf(block), position);
  }

  private checkCallIndex({ module, call, instanceKey, position }: Extract<Reference, { kind: 'output' }>): void {
    const spelled = spellReference([{ name: 'module' }, { name: module }]);

    if (typeof instanceKey === 'number') checkInRange(spelled, instanceKey, this.modules.keysOf(call)?.length, position);
    if (typeof instanceKey === 'string') checkHasKey(spelled, instanceKey, this.modules.keysOf(call), position);
  }
}
