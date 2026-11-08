import { Address, ModuleAddress, Output, SENSITIVE, State } from '@clay/contracts';
import { AttributeValue, DataBlock, ResourceBlock, spell } from '@clay/parser';
import { offPlan, PlanAction } from '@clay/planner';

import { append } from '../append';
import { ScopeManager } from '../config/ScopeManager';
import { ReferenceResolver } from '../expressions/ReferenceResolver';
import { GraphNode, LocalNode, OutputNode, ValueNode } from '../graph/DependencyGraphBuilder';
import { countFrom } from '../instances/count';
import { eachFrom } from '../instances/forEach';
import { Instances } from '../instances/Instances';
import { ModuleInstances } from '../instances/ModuleInstances';
import { Context, contextIn, DataInstance, moduleOf } from '../keys';
import { tryAt, withPlace } from '../place';
import { DataSourceReader } from '../plan/DataSourceReader';
import { shown } from '../shown';
import { outputAs } from '../values/declared';
import { typeFits } from '../values/typeFits';
import { outputOf, Value } from '../values/Value';
import { RunEvent } from './RunEvent';
import { Approved, Checked, PlannedOutput, undeclared } from './savedPlanChecks';

/** What a run applies each block with. */
export interface Applying extends Checked {
  read: Omit<Approved, 'actions' | 'outputs'>;
  blocks: Map<string, ResourceBlock>;
  byBlock: Map<string, PlanAction[]>;
  /** The root outputs' names, in the order the configuration gives them. */
  declared: string[];
  /** Each root output as state will hold it, set as it resolves. */
  resolved: Map<string, Output>;
}

/** Keeps the plan's order within each group. */
export function groupBy(actions: PlanAction[], key: (address: Address) => string): Map<string, PlanAction[]> {
  const groups = new Map<string, PlanAction[]>();
  for (const action of actions) append(groups, key(Address.of(action)), action);

  return groups;
}

/** Works out each block again at apply, after what it reads has run, and holds it to the plan. */
export class ApplyVisitor {
  constructor(
    private scopeManager: ScopeManager,
    private resolver: ReferenceResolver,
    private instances: Instances,
    private modules: ModuleInstances,
    private reader: DataSourceReader
  ) {}

  /** Gives the actions of a resource block, checked; the other kinds are resolved or read. */
  async *visit(key: string, node: GraphNode, { named, outputs, resolved, read, blocks, byBlock }: Applying, state: State): AsyncGenerator<RunEvent, PlanAction[]> {
    if (node.kind === 'module') this.expandCall(node, state);
    if (node.kind === 'data') yield* this.readData(node, named.get(key), read, state);
    if (node.kind === 'local') this.resolveLocal(node, state);
    if (node.kind === 'variable') this.checkVariable(node, state);
    // Only this output: a sibling may read a resource made later.
    if (node.kind === 'output') this.resolveInEvery(node, { outputs, resolved }, state);

    return node.kind === 'resource' ? this.actionsOf(blocks.get(key)!, node.module, byBlock.get(key) ?? [], state) : [];
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
