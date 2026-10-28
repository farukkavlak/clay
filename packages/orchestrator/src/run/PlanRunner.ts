import { Address, ModuleAddress, Output, parseDataAddress, Resource, SENSITIVE, State } from '@clay/contracts';
import { Graph } from '@clay/graph';
import { AttributeValue, DataBlock, OutputBlock, ResourceBlock, spell, Statement } from '@clay/parser';
import { offPlan, Plan, PlanAction } from '@clay/planner';
import { moveResources, StateManager } from '@clay/state';

import { ApplyNode, applyGraph } from '../plan/applyGraph';
import { append } from '../append';
import { asError } from '../asError';
import { countFrom } from '../instances/count';
import { outputAs } from '../values/declared';
import { eachFrom } from '../instances/forEach';
import { Instances, repetitionOfKey } from '../instances/Instances';
import { blockKey, Context, contextIn, DataInstance, dataSourceKey, moduleOf, scopeOf } from '../keys';
import { ModuleInstances } from '../instances/ModuleInstances';
import { Pace } from './parallelism';
import { tryAt, withPlace } from '../place';
import { ReferenceResolver } from '../expressions/ReferenceResolver';
import { RunEvent } from './RunEvent';
import { ScopeManager } from '../config/ScopeManager';
import { shown } from '../shown';
import { typeFits } from '../values/typeFits';
import { outputOf, Value } from '../values/Value';
import { ActionExecutor, Running } from './ActionExecutor';
import { Step, walkTogether } from './walkTogether';
import { LoadedConfig } from './ConfigLoader';
import { DataSourceReader } from '../plan/DataSourceReader';
import { checkMovedFrom, movesIn, plannedMoves } from '../plan/moves';
import { GraphNode, LocalNode, OutputNode, ValueNode } from '../graph/DependencyGraphBuilder';

function undeclared(address: Address | string): Error {
  return new Error(`The plan has "${address}", which the configuration does not declare`);
}

/** Keeps the plan's order within each group. */
function groupBy(actions: PlanAction[], key: (address: Address) => string): Map<string, PlanAction[]> {
  const groups = new Map<string, PlanAction[]>();
  for (const action of actions) append(groups, key(Address.of(action)), action);

  return groups;
}

/** In declared order, so the state does not depend on which resolved first; one not reached keeps its old value. */
function holdOutputs(state: State, { resolved, declared }: Applying): void {
  state.outputs = Object.fromEntries(declared.filter((name) => resolved.has(name)).map((name) => [name, resolved.get(name)!]));
}

/** Held until nothing else runs, so a reader that stops at a failure cannot cut an action short. */
const isFailure = (event: RunEvent) => event.type === 'failed';

type Approved = Pick<Plan, 'actions' | 'outputs' | 'dataSources' | 'dataSensitive' | 'readAtApply'>;

/** What a root output comes to: what the plan shows, or what state holds for one the plan leaves as it is. */
interface PlannedOutput {
  held: Output;
  inPlan: boolean;
  /** The plan printed no value for it: it is sensitive, or was until this plan. */
  hidden: boolean;
}

type PlannedOutputs = Map<string, PlannedOutput>;

/** Checked against the configuration before anything runs, and used as the run goes. */
interface Checked {
  named: Map<string, Set<string>>;
  outputs: PlannedOutputs;
}

/** What a run applies each block with. */
interface Applying extends Checked {
  read: Omit<Approved, 'actions' | 'outputs'>;
  blocks: Map<string, ResourceBlock>;
  byBlock: Map<string, PlanAction[]>;
  /** The root outputs' names, in the order the configuration gives them. */
  declared: string[];
  /** Each root output as state will hold it, set as it resolves. */
  resolved: Map<string, Output>;
}

/** State is written whole before the first action and after the last; each action in between records its own address, so a killed run loses nothing done before it. */
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

  async *run(saved: Approved, config: LoadedConfig, graph: Graph<GraphNode>, state: State, pace: Pace): AsyncGenerator<RunEvent> {
    const { actions } = saved;
    this.checkActionsMatch(actions, graph);
    const outputs = this.plannedOutputs(saved, state);
    this.checkOutputsMatch(outputs, config.mainProgram);
    const checked = { outputs, named: this.dataNamed(saved, graph) };
    checkMovedFrom(actions, movesIn(config.loadedModules), state);
    // Every move first, as the plan made them, so each entry and every dependency on it is at its new address.
    moveResources(state, plannedMoves(actions));
    this.executor.expect(actions, state);

    const order = applyGraph(graph, actions, state);
    // The refreshed resources and the moves, which no action records.
    await this.stateManager.write(state);

    // Set before the last whole write, so one that fails is not tried again.
    let settled = false;
    try {
      yield { type: 'planned', actions };

      if (!(yield* this.applyInOrder(saved, checked, config, order, state, pace))) {
        settled = true;
        yield* this.writeWhole(state);
        return;
      }

      settled = true;
      await this.stateManager.write(state);
      yield { type: 'done', outputs: state.outputs ?? {} };
    } catch (error) {
      if (settled) throw error;
      settled = true;
      yield* this.writeWhole(state);
      throw error;
    } finally {
      // A run its caller stopped reading.
      if (!settled) await this.stateManager.write(state);
    }
  }

  /** Reported apart from what stopped the run, which stays the error; the journal still holds what the run did. */
  private async *writeWhole(state: State): AsyncGenerator<RunEvent> {
    try {
      await this.stateManager.write(state);
    } catch (error) {
      yield { type: 'unsaved', error: asError(error) };
    }
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

    for (const [name, held] of Object.entries(state.outputs ?? {})) if (!Object.hasOwn(outputs, name)) planned.set(name, { held, inPlan: false, hidden: held.sensitive === true });
    for (const [name, { old, new: next }] of Object.entries(outputs))
      if (next !== undefined) planned.set(name, { held: next, inPlan: true, hidden: (old?.sensitive ?? next.sensitive) === true });

    return planned;
  }

  private checkOutputsMatch(planned: PlannedOutputs, program: Statement[]): void {
    const declared = program.filter((stmt) => stmt.type === 'Output');

    for (const stmt of declared) {
      const output = planned.get(stmt.name);
      if (!output) throw withPlace(new Error(`The plan has no output "${stmt.name}", which the configuration declares`), stmt.position, spell(stmt), ModuleAddress.root);

      this.checkFlagMatches(stmt, output);
    }

    const names = new Set(declared.map((stmt) => stmt.name));
    for (const name of planned.keys()) if (!names.has(name)) throw new Error(`The plan has output "${name}", which the configuration does not declare`);
  }

  /** A plan that hid an output would end by printing it, or one that printed it by hiding it. */
  private checkFlagMatches(stmt: OutputBlock, { held, inPlan }: PlannedOutput): void {
    if (held.sensitive === stmt.sensitive) return;

    const was = `the plan ${inPlan ? 'showed' : 'left'} ${stmt.name} as ${held.sensitive ? 'sensitive' : 'not sensitive'}`;
    throw withPlace(new Error(`${was}, but it is ${stmt.sensitive ? 'sensitive' : 'not sensitive'} now. Plan again.`), stmt.position, spell(stmt), ModuleAddress.root);
  }

  /** By block. A saved plan may name a data source with no block, whose value would be silently dropped. */
  private dataNamed({ dataSources, readAtApply }: Approved, graph: Graph<GraphNode>): Map<string, Set<string>> {
    const named = new Map<string, Set<string>>();

    for (const address of [...Object.keys(dataSources), ...readAtApply]) {
      const { module, type, name } = parseDataAddress(address);
      const block = dataSourceKey(scopeOf(module.withoutKeys()), type, name);
      if (!graph.hasNode(block)) throw undeclared(address);

      named.set(block, (named.get(block) ?? new Set()).add(address));
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

    if (this.instances.keysOf(address.toString()) === undefined) return;

    for (const action of actions) if (action.key === undefined || !this.instances.hasKey(address.toString(), action.key)) throw undeclared(Address.of(action));
  }

  /** A plan has an action for every instance, a no-op for one that stays, so one with none would be silently skipped. */
  private checkEveryInstancePlanned(address: Address, block: ResourceBlock, actions: PlanAction[]): void {
    const keys = this.instances.keysOf(address.toString()) ?? [undefined];
    const planned = new Set(actions.map((action) => action.key));

    for (const key of keys) {
      if (planned.has(key)) continue;

      const instance = new Address(address.module, address.resourceType, address.name, key);
      throw withPlace(new Error(`The plan has no action for ${instance}, which the configuration declares`), block.position, spell(block), instance);
    }
  }

  private async *applyInOrder(
    { actions, ...read }: Approved,
    { named, outputs }: Checked,
    config: LoadedConfig,
    graph: Graph<ApplyNode>,
    state: State,
    pace: Pace
  ): AsyncGenerator<RunEvent, boolean> {
    const applying: Applying = {
      named,
      outputs,
      read,
      blocks: new Map(config.loadedResources.map(({ uniqueId, block }) => [uniqueId, block])),
      byBlock: groupBy(
        actions.filter((action) => action.type !== 'DELETE'),
        blockKey
      ),
      declared: config.mainProgram.flatMap((stmt) => (stmt.type === 'Output' ? [stmt.name] : [])),
      resolved: new Map(Object.entries(state.outputs ?? {})),
    };
    // Each replace's object destroyed before its block runs, kept for what it ignored.
    const destroyed = new Map<string, Resource>();
    const reach = (key: string) => this.reach(key, graph.getNode(key)!, applying, state, pace.signal, destroyed);

    try {
      return yield* walkTogether(graph.topologicalSort().flat(), graph, reach, pace.parallelism, isFailure);
    } finally {
      holdOutputs(state, applying);
    }
  }

  /** A data source is not read once the run is stopped; locals and outputs are still worked out. */
  private async *reach(
    key: string,
    node: ApplyNode,
    applying: Applying,
    state: State,
    signal: AbortSignal | undefined,
    destroyed: Map<string, Resource>
  ): AsyncGenerator<RunEvent, Step<RunEvent>[] | false> {
    if (node.kind === 'wait') return [];
    if (node.kind === 'destroy') return [() => this.destroyApart(node.action, state, signal, destroyed)];
    if (signal?.aborted && node.kind === 'data') return false;

    const actions = yield* this.visit(key, node, applying, state);
    return actions.map((action) => {
      const resource = applying.blocks.get(key)!;
      const running = { written: resource.attributes, destroyed: destroyed.get(Address.of(action).toString()), resource };
      return () => this.step(action, state, signal, running);
    });
  }

  /** A delete, reported as any action, or a replace's object, which the replace's block makes again. */
  private destroyApart(action: PlanAction, state: State, signal: AbortSignal | undefined, destroyed: Map<string, Resource>): AsyncGenerator<RunEvent, boolean> {
    if (action.type === 'DELETE') return this.step(action, state, signal);

    const key = Address.of(action).toString();
    destroyed.set(key, state.resources[key]);
    return this.destroyFirst(action, state, signal);
  }

  /** Gives the actions of a resource block, checked; the other kinds are resolved or read. */
  private async *visit(key: string, node: GraphNode, { named, outputs, resolved, read, blocks, byBlock }: Applying, state: State): AsyncGenerator<RunEvent, PlanAction[]> {
    if (node.kind === 'module') this.expandCall(node, state);
    if (node.kind === 'data') yield* this.readData(node, named.get(key), read, state);
    if (node.kind === 'local') this.resolveLocal(node, state);
    if (node.kind === 'variable') this.checkVariable(node, state);
    // Only this output: a sibling may read a resource made later.
    if (node.kind === 'output') this.resolveInEvery(node, { outputs, resolved }, state);

    return node.kind === 'resource' ? this.actionsOf(blocks.get(key)!, node.module, byBlock.get(key) ?? [], state) : [];
  }

  /** The plan's value, or a read now, after what it reads has run. A plan that has neither was made from another configuration. */
  private async *readData(
    { module, block }: Extract<GraphNode, { kind: 'data' }>,
    named = new Set<string>(),
    { dataSources, dataSensitive }: Pick<Approved, 'dataSources' | 'dataSensitive'>,
    state: State
  ): AsyncGenerator<RunEvent> {
    const made = this.modules.of(module).flatMap((instance) => this.dataInstances(block, instance, state));
    const making = new Set(made.map((at) => at.toString()));

    // An instance the module or the count does not make would otherwise be silently skipped.
    for (const address of named) if (!making.has(address)) throw undeclared(address);

    for (const at of made) {
      const address = at.toString();
      if (Object.hasOwn(dataSources, address)) {
        this.reader.use(at, dataSources[address], dataSensitive?.[address]);
        continue;
      }

      // `named` holds a read at apply for each instance with no value.
      if (!named.has(address)) throw withPlace(new Error(`The plan has no value for ${address}, which the configuration declares`), block.position, spell(block), at);

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
  private actionsOf(block: ResourceBlock, module: ModuleAddress, actions: PlanAction[], state: State): PlanAction[] {
    const blocks = this.modules.of(module).map((instance) => new Address(instance, block.resourceType, block.name));
    const byInstance = groupBy(actions, (address) => address.withoutKey().toString());

    const declared = new Set(blocks.map((at) => at.toString()));
    for (const [instance, instanceActions] of byInstance) if (!declared.has(instance)) throw undeclared(Address.of(instanceActions[0]));

    return blocks.flatMap((at) => {
      const instanceActions = byInstance.get(at.toString()) ?? [];
      this.readKeys(at, block, instanceActions, state);
      this.checkEveryInstancePlanned(at, block, instanceActions);

      return instanceActions;
    });
  }

  private async *step(action: PlanAction, state: State, signal?: AbortSignal, running: Running = {}): AsyncGenerator<RunEvent, boolean> {
    if (signal?.aborted) return false;

    // A no-op is not reported, but its dependencies are saved. A move, or a change in which parts are sensitive or in what a destroy is prevented, is reported.
    const quiet = action.type === 'NO_OP' && !action.movedFrom && !action.marksChange && !action.protectionChange;
    if (!quiet) yield { type: 'started', action };

    const key = Address.of(action).toString();
    const held = Object.hasOwn(state.resources, key);
    const lost = () => held && !Object.hasOwn(state.resources, key);
    if (!(yield* this.attempt(action, state, () => this.executor.execute(action, state, running), lost))) return false;

    await this.stateManager.record(state, key);
    if (quiet) return true;

    yield { type: 'applied', action };
    return true;
  }

  /** Reported as it happens: the run may stop before the replace makes its new object. */
  private async *destroyFirst(action: PlanAction, state: State, signal?: AbortSignal): AsyncGenerator<RunEvent, boolean> {
    if (signal?.aborted) return false;
    if (!(yield* this.attempt(action, state, () => this.executor.destroy(action, state)))) return false;

    await this.stateManager.record(state, Address.of(action).toString());
    yield { type: 'destroyed', action };
    return true;
  }

  /** `lost` says whether the failed change destroyed the object, as a replace does before its create. */
  private async *attempt(action: PlanAction, state: State, change: () => Promise<void>, lost = () => false): AsyncGenerator<RunEvent, boolean> {
    try {
      await change();
      return true;
    } catch (error) {
      const stateError = await this.saveAfterFailure(state, Address.of(action).toString());
      if (lost()) yield { type: 'destroyed', action };
      yield { type: 'failed', action, error: asError(error), stateError };
      return false;
    }
  }

  /** State is saved whatever the failure left. */
  private async saveAfterFailure(state: State, key: string): Promise<Error | undefined> {
    try {
      await this.stateManager.record(state, key);
      return undefined;
    } catch (error) {
      return asError(error);
    }
  }

  /** Read again, after what it reads has run, so its type and rules check a value the plan did not know even where nothing reads it. */
  private checkVariable(node: ValueNode, state: State): void {
    for (const instance of this.modules.of(node.module)) this.resolver.resolveVariable(node.name, instance, state);
  }

  /** Worked out again, after what it reads has run. */
  private resolveLocal(node: LocalNode, state: State): void {
    for (const instance of this.modules.of(node.module)) {
      const value = tryAt(node.position, node.declaration, instance, () => this.resolver.resolveValue(node.value, state, instance));
      this.scopeManager.setLocal(instance.toString(), node.name, value);
    }
  }

  private resolveInEvery(node: OutputNode, { outputs, resolved }: Pick<Applying, 'outputs' | 'resolved'>, state: State): void {
    for (const instance of this.modules.of(node.module)) {
      const value = this.resolveOutput(node, instance, state);
      if (!instance.isRoot()) continue;

      this.checkOutput(node, value, outputs.get(node.name)!);
      resolved.set(node.name, outputOf(value, node.declared.sensitive));
    }
  }

  /** Held to the plan as a resource's values are before it runs. What the plan could not know may be anything. */
  private checkOutput(node: OutputNode, value: Value, { held, inPlan, hidden }: PlannedOutput): void {
    const off = offPlan({ value: { type: held.type } }, { value: held.value }, { value: value.data });
    const sameType = typeFits(held.type, value.type);
    if (!off && sameType) return;

    const before = hidden ? SENSITIVE : shown(held.value);
    const was = inPlan ? `the plan showed ${node.name} = ${before}` : `the plan left ${node.name} = ${before} as it was`;
    const shownNow = `${shown(value.data)}${sameType ? '' : ' of another type'}`;
    // A value the plan hid is not printed here either.
    const now = hidden ? (off ? 'another value' : 'another type') : shownNow;
    throw withPlace(new Error(`${was}, but it now comes to ${now}. Plan again.`), node.position, node.declaration, ModuleAddress.root);
  }

  private resolveOutput(node: OutputNode, instance: ModuleAddress, state: State): Value {
    const context = contextIn(node.context, instance);
    const value = tryAt(node.position, node.declaration, context, () => this.outputValue(node.name, node.value, node.declared, state, context));

    this.scopeManager.setOutput(instance, node.name, value);
    return value;
  }

  private outputValue(name: string, value: AttributeValue, declared: OutputNode['declared'], state: State, context: Context): Value {
    const resolved = this.resolver.resolveValue(value, state, context);
    return outputAs(name, resolved, declared, (node) => this.resolver.resolveValue(node, state, context), { root: moduleOf(context).isRoot(), maybe: true });
  }
}
