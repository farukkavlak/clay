import { Address, ModuleAddress, Output, parseDataAddress, SENSITIVE, State } from '@clay/contracts';
import { Graph } from '@clay/graph';
import { AttributeValue, DataBlock, ResourceBlock, spell, Statement } from '@clay/parser';
import { offPlan, Plan, PlanAction } from '@clay/planner';
import { moveResource, StateManager } from '@clay/state';

import { asError } from '../asError';
import { countFrom } from '../count';
import { declaredOf, givenTo } from '../declared';
import { eachFrom } from '../forEach';
import { Instances, repetitionOfKey } from '../Instances';
import { blockKey, Context, contextIn, DataInstance, dataSourceKey, scopeOf } from '../keys';
import { ModuleInstances } from '../ModuleInstances';
import { tryAt, withPlace } from '../place';
import { ReferenceResolver } from '../resolvers/ReferenceResolver';
import { RunEvent } from '../RunEvent';
import { ScopeManager } from '../scope/ScopeManager';
import { shown } from '../shown';
import { typeFits } from '../typeFits';
import { outputOf, Value } from '../Value';
import { ActionExecutor } from './ActionExecutor';
import { LoadedConfig } from './ConfigLoader';
import { DataSourceReader } from './DataSourceReader';
import { GraphNode, LocalNode, OutputNode } from './DependencyGraphBuilder';

function undeclared(address: Address | string): Error {
  return new Error(`The plan has "${address}", which the configuration does not declare`);
}

/** Keeps the plan's order within each group. */
function groupBy(actions: PlanAction[], key: (address: Address) => string): Map<string, PlanAction[]> {
  const groups = new Map<string, PlanAction[]>();

  for (const action of actions) {
    const group = key(Address.of(action));
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push(action);
  }

  return groups;
}

type Approved = Pick<Plan, 'actions' | 'outputs' | 'dataSources' | 'readAtApply'>;

/** What a root output comes to: what the plan shows, or what state holds for one the plan leaves as it is. */
interface PlannedOutput {
  held: Output;
  inPlan: boolean;
}

type PlannedOutputs = Map<string, PlannedOutput>;

/** Checked against the configuration before anything runs, and used as the run goes. */
interface Checked {
  named: Map<string, string[]>;
  outputs: PlannedOutputs;
}

/** State is written after every action, so a failed run loses nothing done before it. */
export class PlanRunner {
  constructor(
    private stateManager: StateManager,
    private executor: ActionExecutor,
    private scopeManager: ScopeManager,
    private resolver: ReferenceResolver,
    private instances: Instances,
    private modules: ModuleInstances,
    private reader: DataSourceReader
  ) {}

  async *run(saved: Approved, config: LoadedConfig, graph: Graph<GraphNode>, state: State): AsyncGenerator<RunEvent> {
    const { actions } = saved;
    this.checkActionsMatch(actions, graph);
    const outputs = this.plannedOutputs(saved, state);
    this.checkOutputsMatch(outputs, config.mainProgram);
    const checked = { outputs, named: this.dataNamed(saved, graph) };

    yield { type: 'planned', actions };

    // Outputs belong to a finished run, so every write before the last omits them.
    delete state.outputs;
    if (!(yield* this.applyInOrder(saved, checked, config, graph, state))) return;
    if (!(yield* this.applyDeletes(actions, state))) return;

    // Resolved after the last action, so outputs never reflect a half-applied run.
    state.outputs = this.resolveOutputs(config.mainProgram, state, ModuleAddress.root);
    await this.stateManager.write(state);
    yield { type: 'done', outputs: state.outputs };
  }

  /** A saved plan may hold an action with no block, which would be silently skipped, or a key unlike its block's, which would run another instance. */
  private checkActionsMatch(actions: PlanAction[], graph: Graph<GraphNode>): void {
    for (const action of actions) {
      const address = Address.of(action);
      const block = blockKey(address);
      const declared = graph.hasNode(block) && repetitionOfKey(action.key) === this.instances.repetitionOf(block);

      if (action.type !== 'DELETE' && !declared) throw undeclared(address);
    }
  }

  /** A plan shows each output that comes, goes or changes, so the others are the ones in state. */
  private plannedOutputs({ outputs }: Approved, state: State): PlannedOutputs {
    const planned: PlannedOutputs = new Map();

    for (const [name, held] of Object.entries(state.outputs ?? {})) if (!Object.hasOwn(outputs, name)) planned.set(name, { held, inPlan: false });
    for (const [name, { new: next }] of Object.entries(outputs)) if (next !== undefined) planned.set(name, { held: next, inPlan: true });

    return planned;
  }

  private checkOutputsMatch(planned: PlannedOutputs, program: Statement[]): void {
    const declared = program.filter((stmt) => stmt.type === 'Output');

    for (const stmt of declared)
      if (!planned.has(stmt.name))
        throw withPlace(new Error(`The plan has no output "${stmt.name}", which the configuration declares`), stmt.position, spell(stmt), ModuleAddress.root);

    for (const name of planned.keys()) if (!declared.some((stmt) => stmt.name === name)) throw new Error(`The plan has output "${name}", which the configuration does not declare`);
  }

  /** By block. A saved plan may name a data source with no block, whose value would be silently dropped. */
  private dataNamed({ dataSources, readAtApply }: Approved, graph: Graph<GraphNode>): Map<string, string[]> {
    const named = new Map<string, string[]>();

    for (const address of [...Object.keys(dataSources), ...readAtApply]) {
      const { module, type, name } = parseDataAddress(address);
      const block = dataSourceKey(scopeOf(module.withoutKeys()), type, name);
      if (!graph.hasNode(block)) throw undeclared(address);

      named.set(block, [...(named.get(block) ?? []), address]);
    }

    return named;
  }

  /**
   * count and for_each are read again at apply, after what they read has run.
   * A plan made from another configuration may name an index or a key they do not give.
   */
  private readKeys(address: Address, block: ResourceBlock, actions: PlanAction[], state: State): void {
    const { count, forEach } = block;
    const read = <T>(value: AttributeValue, from: (value: Value) => T) =>
      tryAt(value.position, spell(block), address, () => from(this.resolver.resolveValue(value, state, address)));

    if (count) this.instances.setCount(address.toString(), read(count, countFrom));
    if (forEach) this.instances.setEach(address.toString(), read(forEach, eachFrom));

    const keys = this.instances.keysOf(address.toString());
    if (keys === undefined) return;

    for (const action of actions) if (action.key === undefined || !keys.includes(action.key)) throw undeclared(Address.of(action));
  }

  /** A plan has an action for every instance, a no-op for one that stays, so one with none would be silently skipped. */
  private checkEveryInstancePlanned(address: Address, block: ResourceBlock, actions: PlanAction[]): void {
    const keys = this.instances.keysOf(address.toString()) ?? [undefined];

    for (const key of keys) {
      if (actions.some((action) => action.key === key)) continue;

      const instance = new Address(address.module, address.resourceType, address.name, key);
      throw withPlace(new Error(`The plan has no action for ${instance}, which the configuration declares`), block.position, spell(block), instance);
    }
  }

  private async *applyInOrder(
    { actions, ...read }: Approved,
    { named, outputs }: Checked,
    config: LoadedConfig,
    graph: Graph<GraphNode>,
    state: State
  ): AsyncGenerator<RunEvent, boolean> {
    const blocks = new Map(config.loadedResources.map(({ uniqueId, block }) => [uniqueId, block]));
    const byBlock = groupBy(
      actions.filter((action) => action.type !== 'DELETE'),
      blockKey
    );

    for (const layer of graph.topologicalSort())
      for (const key of this.outputsFirst(layer, graph)) {
        const node = graph.getNode(key)!;

        if (node.kind === 'module') this.expandCall(node, state);
        if (node.kind === 'data') yield* this.readData(node, named.get(key), read, state);
        if (node.kind === 'local') this.resolveLocal(node, state);
        // Only this output: a sibling may read a resource a later layer creates.
        if (node.kind === 'output') this.resolveInEvery(node, outputs, state);
        if (node.kind === 'resource' && !(yield* this.applyBlock(blocks.get(key)!, node.module, byBlock.get(key) ?? [], state))) return false;
      }

    return true;
  }

  /** The plan's value, or a read now, after what it reads has run. A plan that has neither was made from another configuration. */
  private async *readData(
    { module, block }: Extract<GraphNode, { kind: 'data' }>,
    named: string[] = [],
    { dataSources, readAtApply }: Pick<Approved, 'dataSources' | 'readAtApply'>,
    state: State
  ): AsyncGenerator<RunEvent> {
    const made = this.modules.of(module).flatMap((instance) => this.dataInstances(block, instance, state));

    // An instance the module or the count does not make would otherwise be silently skipped.
    for (const address of named) if (!made.some((at) => at.toString() === address)) throw undeclared(address);

    for (const at of made) {
      const address = at.toString();
      if (Object.hasOwn(dataSources, address)) {
        this.reader.use(at, dataSources[address]);
        continue;
      }

      if (!readAtApply.includes(address)) throw withPlace(new Error(`The plan has no value for ${address}, which the configuration declares`), block.position, spell(block), at);

      await this.reader.read(block, this.resolveInputs(block, state, at), at);
      yield { type: 'read', address };
    }
  }

  /** count and for_each are read again at apply, after what they read has run, as a resource's are. */
  private dataInstances(block: DataBlock, module: ModuleAddress, state: State): DataInstance[] {
    const at = new DataInstance(module, block.dataSourceType, block.name);
    const read = <T>(value: AttributeValue, from: (value: Value) => T) => tryAt(value.position, spell(block), at, () => from(this.resolver.resolveValue(value, state, at)));

    if (block.count) this.instances.setCount(at.block, read(block.count, countFrom));
    if (block.forEach) this.instances.setEach(at.block, read(block.forEach, eachFrom));

    return at.instances(this.instances.keysOf(at.block));
  }

  private resolveInputs(block: DataBlock, state: State, at: DataInstance): Record<string, Value> {
    const declaration = spell(block);

    return Object.fromEntries(
      Object.entries(block.attributes).map(([name, value]) => [name, tryAt(value.position, declaration, at, () => this.resolver.resolveValue(value, state, at))])
    );
  }

  /** Read again at apply, as a resource's count and for_each are. */
  private expandCall({ module, block }: Extract<GraphNode, { kind: 'module' }>, state: State): void {
    this.modules.expandCall(module, block, (value, parse, caller) => tryAt(value.position, spell(block), caller, () => parse(this.resolver.resolveValue(value, state, caller))));
  }

  /** A saved plan may name a module instance the configuration no longer makes, which would otherwise be silently skipped. */
  private async *applyBlock(block: ResourceBlock, module: ModuleAddress, actions: PlanAction[], state: State): AsyncGenerator<RunEvent, boolean> {
    const blocks = this.modules.of(module).map((instance) => new Address(instance, block.resourceType, block.name));
    const byInstance = groupBy(actions, (address) => address.withoutKey().toString());

    for (const [instance, instanceActions] of byInstance) if (!blocks.some((at) => at.toString() === instance)) throw undeclared(Address.of(instanceActions[0]));

    for (const at of blocks) {
      const instanceActions = byInstance.get(at.toString()) ?? [];
      this.readKeys(at, block, instanceActions, state);
      this.checkEveryInstancePlanned(at, block, instanceActions);

      for (const action of instanceActions) if (!(yield* this.step(action, state))) return false;
    }

    return true;
  }

  /** Ordered by the dependencies in state, since the config no longer has the resource. */
  private async *applyDeletes(actions: PlanAction[], state: State): AsyncGenerator<RunEvent, boolean> {
    const deletes = new Map(actions.filter((action) => action.type === 'DELETE').map((action) => [Address.of(action).toString(), action]));
    const graph = this.deleteGraph(deletes, state);

    for (const layer of graph.topologicalSort().reverse()) for (const key of layer) if (!(yield* this.step(graph.getNode(key)!, state))) return false;

    return true;
  }

  private deleteGraph(deletes: Map<string, PlanAction>, state: State): Graph<PlanAction> {
    const graph = new Graph<PlanAction>();

    for (const [key, action] of deletes) graph.addNode(key, action);

    for (const key of deletes.keys()) for (const dependency of state.resources[key]?.dependencies ?? []) if (deletes.has(dependency)) graph.addEdge(dependency, key);

    return graph;
  }

  private async *step(action: PlanAction, state: State): AsyncGenerator<RunEvent, boolean> {
    // A no-op is not reported; the final write saves its dependencies. A move is reported and saved.
    const quiet = action.type === 'NO_OP' && !action.movedFrom;
    if (!quiet) yield { type: 'started', action };

    try {
      // Moved first, so the action finds the resource at its new address.
      if (action.movedFrom) moveResource(state, Address.parse(action.movedFrom), Address.of(action));
      await this.executor.execute(action, state);
    } catch (error) {
      yield { type: 'failed', action, error: asError(error), stateError: await this.saveAfterFailure(state) };
      return false;
    }

    if (quiet) return true;

    await this.stateManager.write(state);
    yield { type: 'applied', action };
    return true;
  }

  /** A replace may have deleted before its create failed; state is saved either way. */
  private async saveAfterFailure(state: State): Promise<Error | undefined> {
    try {
      await this.stateManager.write(state);
      return undefined;
    } catch (error) {
      return asError(error);
    }
  }

  private resolveOutputs(program: Statement[], state: State, context: ModuleAddress): Record<string, Output> {
    // A map, so an output named `__proto__` is a key like any other.
    const outputs = new Map<string, Output>();
    const scope = scopeOf(context);

    for (const stmt of program)
      if (stmt.type === 'Output') {
        const resolved = tryAt(stmt.value.position, spell(stmt), context, () => this.outputValue(stmt.name, stmt.value, declaredOf(stmt), state, context));
        outputs.set(stmt.name, outputOf(resolved, stmt.sensitive));
        this.scopeManager.setOutput(scope, stmt.name, resolved);
      }

    return Object.fromEntries(outputs);
  }

  /** Nothing in a layer reads another of it, so an output that is not what the plan showed stops the run before the layer's resources. */
  private outputsFirst(layer: string[], graph: Graph<GraphNode>): string[] {
    const isOutput = (key: string) => graph.getNode(key)!.kind === 'output';

    return [...layer.filter((key) => isOutput(key)), ...layer.filter((key) => !isOutput(key))];
  }

  /** Worked out again, after what it reads has run. */
  private resolveLocal(node: LocalNode, state: State): void {
    for (const instance of this.modules.of(node.module)) {
      const value = tryAt(node.position, node.declaration, instance, () => this.resolver.resolveValue(node.value, state, instance));
      this.scopeManager.setLocal(instance.toString(), node.name, value);
    }
  }

  private resolveInEvery(node: OutputNode, planned: PlannedOutputs, state: State): void {
    for (const instance of this.modules.of(node.module)) {
      const value = this.resolveOutput(node, instance, state);
      if (instance.isRoot()) this.checkOutput(node, value, planned.get(node.name)!);
    }
  }

  /** Held to the plan as a resource's values are before it runs. What the plan could not know may be anything. */
  private checkOutput(node: OutputNode, value: Value, { held, inPlan }: PlannedOutput): void {
    const off = offPlan({ value: { type: held.type } }, { value: held.value }, { value: value.data });
    const sameType = typeFits(held.type, value.type);
    const { sensitive } = node.declared;
    if (!off && sameType && held.sensitive === sensitive) return;

    throw withPlace(
      new Error(`${this.outputWas(node.name, held, inPlan, sensitive)}, but ${this.outputNow(value, held, off !== undefined, sensitive)}. Plan again.`),
      node.position,
      node.declaration,
      ModuleAddress.root
    );
  }

  /** Hidden if either says so: the plan may have hidden what the configuration now would print. */
  private outputWas(name: string, held: Output, inPlan: boolean, sensitive?: true): string {
    if (held.sensitive !== sensitive) return `the plan ${inPlan ? 'showed' : 'left'} ${name} as ${held.sensitive ? 'sensitive' : 'not sensitive'}`;

    const before = sensitive ? SENSITIVE : shown(held.value);
    return inPlan ? `the plan showed ${name} = ${before}` : `the plan left ${name} = ${before} as it was`;
  }

  /** A plan that hid an output is not run with a configuration that prints it, nor the other way round. */
  private outputNow(value: Value, held: Output, off: boolean, sensitive?: true): string {
    if (held.sensitive !== sensitive) return `it is ${sensitive ? 'sensitive' : 'not sensitive'} now`;
    if (!sensitive) return `it now comes to ${shown(value.data)}${typeFits(held.type, value.type) ? '' : ' of another type'}`;

    return `it now comes to ${off ? 'another value' : 'another type'}`;
  }

  private resolveOutput(node: OutputNode, instance: ModuleAddress, state: State): Value {
    const context = contextIn(node.context, instance);
    const value = tryAt(node.position, node.declaration, context, () => this.outputValue(node.name, node.value, node.declared, state, context));

    this.scopeManager.setOutput(instance.toString(), node.name, value);
    return value;
  }

  private outputValue(name: string, value: AttributeValue, declared: OutputNode['declared'], state: State, context: Context): Value {
    const resolved = this.resolver.resolveValue(value, state, context);
    return givenTo('output', name, resolved, declared, (node) => this.resolver.resolveValue(node, state, context));
  }
}
