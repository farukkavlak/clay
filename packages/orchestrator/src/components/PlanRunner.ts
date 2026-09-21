import { Address, State } from '@clay/contracts';
import { Graph } from '@clay/graph';
import { Statement } from '@clay/parser';
import { PlanAction } from '@clay/planner';
import { StateManager } from '@clay/state';

import { asError } from '../asError';
import { scopeOf } from '../keys';
import { ReferenceResolver } from '../resolvers/ReferenceResolver';
import { RunEvent } from '../RunEvent';
import { ScopeManager } from '../scope/ScopeManager';
import { ActionExecutor } from './ActionExecutor';
import { LoadedConfig } from './ConfigLoader';
import { GraphNode } from './DependencyGraphBuilder';
import { LoadedModule } from './ModuleLoader';

/** Runs a plan's actions in dependency order, reporting each step; the state file is rewritten after every action, so a failed run loses nothing done before it. */
export class PlanRunner {
  constructor(
    private stateManager: StateManager,
    private executor: ActionExecutor,
    private scopeManager: ScopeManager,
    private resolver: ReferenceResolver
  ) {}

  async *run(actions: PlanAction[], config: LoadedConfig, graph: Graph<GraphNode>, state: State): AsyncGenerator<RunEvent> {
    this.checkActionsMatch(actions, graph);

    yield { type: 'planned', actions };

    // Outputs belong to a finished run; every write before the last leaves them out.
    delete state.outputs;
    if (!(yield* this.applyInOrder(actions, graph, config.loadedModules, state))) return;
    if (!(yield* this.applyDeletes(actions, state))) return;

    // Outputs are read after the last action, so they never name a half-applied resource.
    state.outputs = this.resolveOutputs(config.mainProgram, state, Address.root('', ''));
    await this.stateManager.write(state);
    yield { type: 'done', outputs: state.outputs };
  }

  /** An action with no node would be walked past in silence. A plan made from this configuration has one for each; a saved plan may not. */
  private checkActionsMatch(actions: PlanAction[], graph: Graph<GraphNode>): void {
    for (const action of actions) {
      const key = Address.of(action).toString();
      if (action.type !== 'DELETE' && !graph.hasNode(key)) throw new Error(`The plan has "${key}", which the configuration does not declare`);
    }
  }

  /** Creates, updates and replacements follow the graph, so a resource runs after what it reads from. */
  private async *applyInOrder(actions: PlanAction[], graph: Graph<GraphNode>, loadedModules: LoadedModule[], state: State): AsyncGenerator<RunEvent, boolean> {
    const byKey = new Map(actions.map((action) => [Address.of(action).toString(), action]));

    for (const layer of graph.topologicalSort())
      for (const key of layer) {
        const node = graph.getNode(key)!;
        if (node.kind === 'output') this.resolveOutputsOf(node.scope, loadedModules, state);

        const action = byKey.get(key);
        if (!action || action.type === 'DELETE') continue;
        if (!(yield* this.step(action, state))) return false;
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
    // An unchanged resource has nothing to report; it only refreshes what it reads from, and the write that ends the run saves that.
    const quiet = action.type === 'NO_OP';
    if (!quiet) yield { type: 'started', action };

    try {
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

  private resolveOutputsOf(scope: string, loadedModules: LoadedModule[], currentState: State): void {
    const mod = loadedModules.find((m) => scopeOf(m.address) === scope);
    if (mod) this.resolveOutputs(mod.program, currentState, mod.address);
  }
}
