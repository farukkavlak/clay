import { Address, AttributePath, DestroyProvisioner, ModuleAddress, Output, Resource, samePaths, Schema, State } from '@clay/contracts';
import { Graph } from '@clay/graph';
import { AttributeValue, ResourceBlock, spell } from '@clay/parser';
import { DesiredResource, hasChanges } from '@clay/planner';

import { writtenAt } from '../values/conformValues';
import { givenTo, outputAs } from '../values/declared';
import { ignoredPaths } from './ignoredChanges';
import { Instances } from '../instances/Instances';
import { Context, contextIn, DataInstance, enclosing, scopeOf, sharedModule } from '../keys';
import { ModuleInstances } from '../instances/ModuleInstances';
import { Planned } from '../values/Planned';
import { tryAt, withPlace } from '../place';
import { ReferenceResolver } from '../expressions/ReferenceResolver';
import { ScopeManager } from '../config/ScopeManager';
import { validate } from '../expressions/validations';
import { carried, outputOf, sensitiveAmong, Value } from '../values/Value';
import { DataPlanner, DataRead } from './DataPlanner';
import { PlanReader, Walk } from './PlanReader';
import { DependencyGraphBuilder, GraphNode, LocalNode, OutputNode, ValueNode } from '../graph/DependencyGraphBuilder';
import { LoadedResource } from '../config/ModuleLoader';
import { inOrder } from '../providers/Limit';
import { Moves } from './moves';
import { Versions } from '../values/Versions';
import { Ignoring, ResourcePlan, ResourcePlanner } from './ResourcePlanner';
import { keptFor, Provisioning } from '../providers/Provisioning';
import { Queue } from '../Queue';

/** With the block it was planned from, so a refusal can point at it. */
export interface ConfiguredResource extends DesiredResource {
  block: ResourceBlock;
}

export interface DesiredState {
  resources: ConfiguredResource[];
  outputs: Record<string, Output>;
  /** What each data source read at plan gave, by address. */
  dataSources: Record<string, Record<string, Output>>;
  /** The steps to each sensitive part of what a data source read at plan gave, by address, left out where there is none. */
  dataSensitive: Record<string, AttributePath[]>;
  /** Data sources that wait for the apply, since what they read changes in it. */
  readAtApply: string[];
}

/** What planning one node found, kept until every node is planned so the plan lists it in the graph's order. */
interface Found {
  resources?: ConfiguredResource[];
  reads?: DataRead[];
  output?: [string, Output];
}

function changes(current: Resource | undefined, { after, replace }: ResourcePlan): boolean {
  return !current || replace || hasChanges(current.attributes, after);
}

/**
 * One for each block read, so a delete can run after every object of it: keyed as far as the reader's module instance goes into the block's,
 * every instance below that. `module.a[0]` reads from `module.a[0]`, never `module.a[1]`.
 */
function dependenciesOf(blocks: string[], reader: ModuleAddress): string[] {
  return blocks.map((block) => {
    const { module, resourceType, name } = Address.parse(block);
    const shared = enclosing(reader, sharedModule(module, reader.withoutKeys())).path;

    return new Address(new ModuleAddress([...shared, ...module.path.slice(shared.length)]), resourceType, name).toString();
  });
}

/**
 * Resolves resources in dependency order, once per module instance, so a reader sees what the plan will make, not stale state.
 * Each created or changed instance is stored in `planned` as its provider planned it; a reader gets those values, UNKNOWN included.
 */
export class DesiredStateBuilder {
  private schemas = new Map<string, Schema>();
  private createsFirst = new Set<ResourceBlock>();
  private walk: Walk = 'plan';
  private moves = new Moves();

  constructor(
    private scopeManager: ScopeManager,
    private resolver: ReferenceResolver,
    private graphBuilder: DependencyGraphBuilder,
    private instances: Instances,
    private modules: ModuleInstances,
    private planned: Planned,
    private resourcePlanner: ResourcePlanner,
    private provisioning: Provisioning,
    private data: DataPlanner,
    private reads: PlanReader,
    private versions: Versions
  ) {}

  /** The blocks that say it, and every block they read, through any others. A module's block is one for all its instances. */
  private createFirst(loadedResources: LoadedResource[], graph: Graph<GraphNode>): Set<ResourceBlock> {
    const found = new Set<string>();
    const queue = new Queue(loadedResources.filter(({ block }) => block.lifecycle?.createBeforeDestroy === true).map(({ uniqueId }) => uniqueId));

    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      if (found.has(next)) continue;

      found.add(next);
      for (const dependency of this.graphBuilder.resourceDependencies(graph, next)) queue.push(dependency);
    }

    return new Set(loadedResources.filter(({ uniqueId }) => found.has(uniqueId)).map(({ block }) => block));
  }

  /** Applies count moves to `state`, a copy the plan never writes, records each in `moves`, and plans the actions against it. */
  async build(loadedResources: LoadedResource[], graph: Graph<GraphNode>, state: State, schemas: Map<string, Schema>, walk: Walk, moves: Moves): Promise<DesiredState> {
    this.planned.begin();
    this.schemas = schemas;
    this.moves = moves;
    this.walk = walk;
    this.createsFirst = this.createFirst(loadedResources, graph);
    const byKey = new Map(loadedResources.map((r) => [r.address.toString(), r]));
    const found = new Map<string, Found>();

    await graph.walk(async (key) => {
      found.set(key, await this.planNode(key, graph.getNode(key)!, byKey, graph, state));
    });

    return this.desiredFrom(graph, found);
  }

  private async planNode(key: string, node: GraphNode, byKey: Map<string, LoadedResource>, graph: Graph<GraphNode>, state: State): Promise<Found> {
    switch (node.kind) {
      case 'module': {
        this.planCall(node, state);
        return {};
      }
      case 'resource': {
        return { resources: await this.planResource(key, byKey.get(key)!, graph, state) };
      }
      case 'data': {
        return { reads: await this.data.plan(key, node, graph, state, this.walk) };
      }
      case 'output': {
        // A module's own output never reaches the plan, so only the root's one instance gives one.
        const outputs = this.modules.of(node.module).map((instance) => this.planOutput(node, instance, state));
        return { output: outputs.find((output) => output !== undefined) };
      }
      default: {
        for (const instance of this.modules.of(node.module)) this.planValue(node, instance, state);
        return {};
      }
    }
  }

  /** In the graph's order, as a walk one node at a time would find them, so a plan lists the same however the provider answers. */
  private desiredFrom(graph: Graph<GraphNode>, found: Map<string, Found>): DesiredState {
    const desired: DesiredState = { resources: [], outputs: {}, dataSources: {}, dataSensitive: {}, readAtApply: [] };
    // A map, so an output named `__proto__` is a key like any other.
    const rootOutputs = new Map<string, Output>();

    for (const key of graph.topologicalSort().flat()) {
      const { resources = [], reads = [], output } = found.get(key)!;
      desired.resources.push(...resources);
      for (const { at, read } of reads)
        if (read) this.recordRead(desired, at, read);
        else desired.readAtApply.push(at.toString());
      if (output) rootOutputs.set(...output);
    }

    desired.outputs = Object.fromEntries(rootOutputs);
    return desired;
  }

  private recordRead(desired: DesiredState, at: DataInstance, read: Record<string, Value>): void {
    const address = at.toString();
    desired.dataSources[address] = carried(read);

    const sensitive = sensitiveAmong(read);
    if (sensitive.length > 0) desired.dataSensitive[address] = sensitive;
  }

  private planCall({ module, block }: Extract<GraphNode, { kind: 'module' }>, state: State): void {
    this.modules.expandCall(module, block, (value, parse, caller) => this.reads.readAt(this.walk, value, block, caller, state, parse));
  }

  private async planResource(key: string, loaded: LoadedResource, graph: Graph<GraphNode>, state: State): Promise<ConfiguredResource[]> {
    const { address, block } = loaded;
    const blocks = this.graphBuilder.resourceDependencies(graph, key);

    const planned = await inOrder(
      this.modules.of(address.module).map(async (module) => this.planBlock(new Address(module, address.resourceType, address.name), block, dependenciesOf(blocks, module), state))
    );

    return planned.flat();
  }

  private async planBlock(address: Address, block: ResourceBlock, dependencies: string[], state: State): Promise<ConfiguredResource[]> {
    const key = address.toString();
    if (!block.count && !block.forEach) return [await this.planInstance(address, block, dependencies, state)];

    this.reads.setKeys(this.walk, key, block, address, state);

    return inOrder(
      (this.instances.keysOf(key) ?? []).map(async (instance) =>
        this.planInstance(new Address(address.module, address.resourceType, address.name, instance), block, dependencies, state)
      )
    );
  }

  private async planInstance(address: Address, block: ResourceBlock, dependencies: string[], state: State): Promise<ConfiguredResource> {
    tryAt(block.position, spell(block), address, () => this.moveIn(address, state));
    const current = state.resources[address.toString()];
    const ignoring = this.ignoringIn(block, current);
    const change = await this.askProvider(address, block, current, this.resolveForPlan(block, state, address), ignoring);
    const values = changes(current, change);
    // A change of values or of marks goes in, so a reader takes the marks from the plan too.
    if (values || !samePaths(current?.sensitive ?? [], change.sensitive)) this.planned.set(address, change.after, change.sensitive, values);
    const kept = await this.checkProvisioners(block, state, address, !current || change.replace);

    return {
      address,
      block,
      attributes: change.config,
      after: change.after,
      sensitive: change.sensitive,
      replace: change.replace,
      dependencies,
      ...(block.lifecycle?.preventDestroy === true && { preventDestroy: true as const }),
      ...(ignoring && { ignored: ignoring.paths }),
      ...(this.createsFirst.has(block) && { createBeforeDestroy: true as const }),
      ...kept,
    };
  }

  /** Nothing to ignore in what does not exist yet, or in what is replaced because it is tainted. */
  private ignoringIn(block: ResourceBlock, current: Resource | undefined): Ignoring | undefined {
    const paths = ignoredPaths(block.lifecycle?.ignoreChanges, this.schemas.get(block.resourceType) ?? {});

    return current && !current.tainted && paths.length > 0 ? { prior: current, paths } : undefined;
  }

  private async askProvider(address: Address, block: ResourceBlock, current: Resource | undefined, attributes: Record<string, Value>, ignoring?: Ignoring): Promise<ResourcePlan> {
    try {
      return await this.resourcePlanner.plan(block.resourceType, this.schemas.get(block.resourceType) ?? {}, current, attributes, ignoring);
    } catch (error) {
      throw withPlace(error, writtenAt(error, block), spell(block), address);
    }
  }

  /**
   * Moves the instance before anything reads it, so readers find it at its new address.
   * Two possible old addresses would be a guess, so that is refused.
   */
  private moveIn(address: Address, state: State): void {
    if (Object.hasOwn(state.resources, address.toString())) return;

    const found = address.countCounterparts().filter((kept) => Object.hasOwn(state.resources, kept.toString()));
    if (found.length > 1)
      throw new Error(`"${address}" may be ${found.map((kept) => `"${kept}"`).join(' or ')} in state, from before count came or went; say which with a moved block`);

    const [source] = found;
    if (!source) return;

    this.moves.move(state, source, address);
    this.versions.changed(source.withoutKey().toString());
    this.versions.changed(address.withoutKey().toString());
  }

  private planValue(node: Extract<GraphNode, { kind: 'variable' | 'local' }>, instance: ModuleAddress, state: State): void {
    if (node.kind === 'variable') this.planVariable(node, instance, state);
    else this.planLocal(node, instance, state);
  }

  /** Kept as it comes, UNKNOWN where only the apply makes it, so every reader in the instance sees one value. */
  private planLocal(node: LocalNode, instance: ModuleAddress, state: State): void {
    this.scopeManager.setLocal(instance.toString(), node.name, this.resolveNode(node, node.value, instance, state));
  }

  /** Resolved so an error is found at plan even if nothing reads it; each reader resolves it again. */
  private planVariable(node: ValueNode, instance: ModuleAddress, state: State): void {
    if (node.value === undefined) return;

    const declared = this.scopeManager.getVariable(scopeOf(node.module), node.name);
    const value = this.resolveNode(node, node.value, instance, state);
    const read = (constant: AttributeValue) => this.resolveNode(node, constant, instance, state);
    tryAt(node.position, node.declaration, contextIn(node.context, instance), () => {
      const typed = givenTo('variable', node.name, value, declared ?? {}, read);
      if (declared) validate(node.name, declared, typed, { module: instance, state, reader: this.resolver });
    });
  }

  private planOutput(node: OutputNode, instance: ModuleAddress, state: State): [string, Output] | undefined {
    const read = (constant: AttributeValue) => this.resolveNode(node, constant, instance, state);
    const resolved = this.resolveNode(node, node.value, instance, state);
    const value = tryAt(node.position, node.declaration, contextIn(node.context, instance), () =>
      outputAs(node.name, resolved, node.declared, read, { root: instance.isRoot(), maybe: this.walk === 'plan' })
    );
    this.scopeManager.setOutput(instance, node.name, value);

    return instance.isRoot() ? [node.name, outputOf(value, node.declared.sensitive)] : undefined;
  }

  /**
   * Read as the resource's own values are: what is known now is checked now, and every value again at apply. Only a create runs the others,
   * so an instance the plan makes no object for is not checked for them, and `self` reads the one it makes, already in the plan.
   * One run before a destroy is resolved again at every apply, so it is checked at every plan, and given back as state would keep it.
   */
  private async checkProvisioners(block: ResourceBlock, state: State, address: Address, creates: boolean): Promise<Pick<DesiredResource, 'destroyProvisioners'>> {
    const declaration = spell(block);
    const kept: DestroyProvisioner[] = [];
    for (const provisioner of block.provisioners ?? []) {
      if (!creates && provisioner.when !== 'destroy') continue;
      const given = Object.fromEntries(
        Object.entries(provisioner.attributes).map(([name, value]) => [name, tryAt(value.position, declaration, address, () => this.reads.resolveOrUnknown(value, state, address))])
      );
      const checked = await this.provisioning.check(provisioner, given, declaration, address);
      if (provisioner.when === 'destroy') kept.push(keptFor(provisioner, checked));
    }

    return kept.length > 0 ? { destroyProvisioners: kept } : {};
  }

  private resolveForPlan(block: ResourceBlock, state: State, context: Context): Record<string, Value> {
    const resolved: Record<string, Value> = {};
    const declaration = spell(block);

    for (const [key, value] of Object.entries(block.attributes))
      resolved[key] = tryAt(value.position, declaration, context, () => this.reads.resolveOrUnknown(value, state, context));

    return resolved;
  }

  private resolveNode(node: ValueNode, value: AttributeValue, instance: ModuleAddress, state: State): Value {
    const context = contextIn(node.context, instance);
    return tryAt(node.position, node.declaration, context, () => this.reads.resolveOrUnknown(value, state, context));
  }
}
