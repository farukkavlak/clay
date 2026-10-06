import { Address, ModuleAddress, Output, State } from '@clay/contracts';
import { Graph } from '@clay/graph';
import { AttributeValue, ResourceBlock, spell, Statement } from '@clay/parser';
import { PlanAction } from '@clay/planner';
import { moveResource, StateManager } from '@clay/state';

import { asError } from '../asError';
import { countFrom } from '../count';
import { declaredOf, givenTo } from '../declared';
import { eachFrom } from '../forEach';
import { Instances, repetitionOfKey } from '../Instances';
import { blockKey, Context, contextIn, scopeOf } from '../keys';
import { ModuleInstances } from '../ModuleInstances';
import { tryAt } from '../place';
import { ReferenceResolver } from '../resolvers/ReferenceResolver';
import { RunEvent } from '../RunEvent';
import { ScopeManager } from '../scope/ScopeManager';
import { Value } from '../Value';
import { ActionExecutor } from './ActionExecutor';
import { LoadedConfig } from './ConfigLoader';
import { GraphNode, OutputNode } from './DependencyGraphBuilder';

function undeclared(address: Address): Error {
  return new Error(`The plan has "${address.toString()}", which the configuration does not declare`);
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

/** State is written after every action, so a failed run loses nothing done before it. */
export class PlanRunner {
  constructor(
    private stateManager: StateManager,
    private executor: ActionExecutor,
    private scopeManager: ScopeManager,
    private resolver: ReferenceResolver,
    private instances: Instances,
    private modules: ModuleInstances
  ) {}

  async *run(actions: PlanAction[], config: LoadedConfig, graph: Graph<GraphNode>, state: State): AsyncGenerator<RunEvent> {
    this.checkActionsMatch(actions, graph);

    yield { type: 'planned', actions };

    // Outputs belong to a finished run, so every write before the last omits them.
    delete state.outputs;
    if (!(yield* this.applyInOrder(actions, config, graph, state))) return;
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

  private async *applyInOrder(actions: PlanAction[], config: LoadedConfig, graph: Graph<GraphNode>, state: State): AsyncGenerator<RunEvent, boolean> {
    const blocks = new Map(config.loadedResources.map(({ uniqueId, block }) => [uniqueId, block]));
    const byBlock = groupBy(
      actions.filter((action) => action.type !== 'DELETE'),
      blockKey
    );

    for (const layer of graph.topologicalSort())
      for (const key of layer) {
        const node = graph.getNode(key)!;

        if (node.kind === 'module') this.expandCall(node, state);
        // Only this output: a sibling may read a resource a later layer creates.
        if (node.kind === 'output') for (const instance of this.modules.of(node.module)) this.resolveOutput(node, instance, state);
        if (node.kind === 'resource' && !(yield* this.applyBlock(blocks.get(key)!, node.module, byBlock.get(key) ?? [], state))) return false;
      }

    return true;
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
    const outputs: Record<string, Output> = {};
    const scope = scopeOf(context);

    for (const stmt of program)
      if (stmt.type === 'Output') {
        const resolved = tryAt(stmt.value.position, spell(stmt), context, () => this.outputValue(stmt.name, stmt.value, declaredOf(stmt), state, context));
        outputs[stmt.name] = { value: resolved.data, type: resolved.type };
        this.scopeManager.setOutput(scope, stmt.name, resolved);
      }

    return outputs;
  }

  private resolveOutput(node: OutputNode, instance: ModuleAddress, state: State): void {
    const context = contextIn(node.context, instance);
    const value = tryAt(node.position, node.declaration, context, () => this.outputValue(node.name, node.value, node.declared, state, context));

    this.scopeManager.setOutput(instance.toString(), node.name, value);
  }

  private outputValue(name: string, value: AttributeValue, declared: OutputNode['declared'], state: State, context: Context): Value {
    const resolved = this.resolver.resolveValue(value, state, context);
    return givenTo('output', name, resolved, declared, (node) => this.resolver.resolveValue(node, state, context));
  }
}
