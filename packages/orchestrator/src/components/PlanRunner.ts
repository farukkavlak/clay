import { Address, State } from '@clay/contracts';
import { Graph } from '@clay/graph';
import { ResourceBlock, spell, Statement } from '@clay/parser';
import { PlanAction } from '@clay/planner';
import { moveResource, StateManager } from '@clay/state';

import { asError } from '../asError';
import { eachFrom } from '../forEach';
import { Instances, repetitionOfKey } from '../Instances';
import { scopeOf } from '../keys';
import { tryAt } from '../place';
import { ReferenceResolver } from '../resolvers/ReferenceResolver';
import { RunEvent } from '../RunEvent';
import { ScopeManager } from '../scope/ScopeManager';
import { ActionExecutor } from './ActionExecutor';
import { LoadedConfig } from './ConfigLoader';
import { GraphNode, ValueNode } from './DependencyGraphBuilder';

function undeclared(address: Address): Error {
  return new Error(`The plan has "${address.toString()}", which the configuration does not declare`);
}

function byBlockOf(actions: PlanAction[]): Map<string, PlanAction[]> {
  const byBlock = new Map<string, PlanAction[]>();

  for (const action of actions) {
    const block = Address.of(action).withoutKey().toString();
    if (!byBlock.has(block)) byBlock.set(block, []);
    byBlock.get(block)!.push(action);
  }

  return byBlock;
}

/** Runs a plan's actions in dependency order, reporting each step; the state file is rewritten after every action, so a failed run loses nothing done before it. */
export class PlanRunner {
  constructor(
    private stateManager: StateManager,
    private executor: ActionExecutor,
    private scopeManager: ScopeManager,
    private resolver: ReferenceResolver,
    private instances: Instances
  ) {}

  async *run(actions: PlanAction[], config: LoadedConfig, graph: Graph<GraphNode>, state: State): AsyncGenerator<RunEvent> {
    this.checkActionsMatch(actions, graph);

    yield { type: 'planned', actions };

    // Outputs belong to a finished run; every write before the last leaves them out.
    delete state.outputs;
    if (!(yield* this.applyInOrder(actions, config, graph, state))) return;
    if (!(yield* this.applyDeletes(actions, state))) return;

    // Outputs are read after the last action, so they never name a half-applied resource.
    state.outputs = this.resolveOutputs(config.mainProgram, state, Address.root('', ''));
    await this.stateManager.write(state);
    yield { type: 'done', outputs: state.outputs };
  }

  /** An action with no block would be walked past in silence, and one keyed unlike its block would be run as another instance. A plan made from this configuration has neither; a saved plan may. */
  private checkActionsMatch(actions: PlanAction[], graph: Graph<GraphNode>): void {
    for (const action of actions) {
      const address = Address.of(action);
      const block = address.withoutKey().toString();
      const declared = graph.hasNode(block) && repetitionOfKey(action.key) === this.instances.repetitionOf(block);

      if (action.type !== 'DELETE' && !declared) throw undeclared(address);
    }
  }

  /**
   * An instance reads `each.value` from what for_each gives now, which is read once what for_each reads has run.
   * A data source is read again for the run, so a saved plan may name a key for_each no longer gives.
   */
  private readEach(key: string, blocks: Map<string, ResourceBlock>, actions: PlanAction[], state: State): void {
    const block = blocks.get(key);
    if (!block?.forEach) return;

    const address = Address.parse(key);
    const values = tryAt(block.forEach.position, spell(block), address, () => eachFrom(this.resolver.resolveValue(block.forEach, state, address)));
    this.instances.setEach(key, values);

    for (const action of actions) if (typeof action.key !== 'string' || !values.has(action.key)) throw undeclared(Address.of(action));
  }

  /** Creates, updates and replacements follow the graph, so a resource runs after what it reads from; the instances of a block run together, in the plan's order. */
  private async *applyInOrder(actions: PlanAction[], config: LoadedConfig, graph: Graph<GraphNode>, state: State): AsyncGenerator<RunEvent, boolean> {
    const blocks = new Map(config.loadedResources.map(({ uniqueId, block }) => [uniqueId, block]));
    const byBlock = byBlockOf(actions.filter((action) => action.type !== 'DELETE'));

    for (const layer of graph.topologicalSort())
      for (const key of layer) {
        const node = graph.getNode(key)!;
        // Only this output: a sibling of it may read a resource a later layer creates.
        if (node.kind === 'output') this.resolveOutput(node, state);
        this.readEach(key, blocks, byBlock.get(key) ?? [], state);

        for (const action of byBlock.get(key) ?? []) if (!(yield* this.step(action, state))) return false;
      }

    return true;
  }

  /** The config no longer knows a removed resource, so its dependencies come from state: a resource goes before what it reads from. */
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
    // An unchanged resource has nothing to report; it only refreshes what it reads from, and the write that ends the run saves that. A move is a change of its own, reported and saved.
    const quiet = action.type === 'NO_OP' && !action.movedFrom;
    if (!quiet) yield { type: 'started', action };

    try {
      // Moved first, so the action finds the resource under the address it runs for.
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

  /** A replacement may have deleted before it failed to create; what happened is saved either way. */
  private async saveAfterFailure(state: State): Promise<Error | undefined> {
    try {
      await this.stateManager.write(state);
      return undefined;
    } catch (error) {
      return asError(error);
    }
  }

  private resolveOutputs(program: Statement[], state: State, context: Address): Record<string, unknown> {
    const outputs: Record<string, unknown> = {};
    const scope = scopeOf(context);

    for (const stmt of program)
      if (stmt.type === 'Output') {
        const resolved = this.resolver.resolveValue(stmt.value, state, context);
        outputs[stmt.name] = resolved;
        this.scopeManager.setOutput(scope, stmt.name, resolved);
      }

    return outputs;
  }

  private resolveOutput(node: ValueNode, state: State): void {
    const value = tryAt(node.position, node.declaration, node.context, () => this.resolver.resolveValue(node.value, state, node.context));

    this.scopeManager.setOutput(node.scope, node.name, value);
  }
}
