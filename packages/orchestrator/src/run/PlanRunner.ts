import { Address, Resource, State } from '@clay/contracts';
import { Graph } from '@clay/graph';
import { changesState, PlanAction } from '@clay/planner';
import { moveResources, StateManager } from '@clay/state';

import { asError } from '../asError';
import { GraphNode } from '../graph/DependencyGraphBuilder';
import { Instances } from '../instances/Instances';
import { blockKey } from '../keys';
import { ApplyNode, applyGraph } from '../plan/applyGraph';
import { checkMovedFrom, copyResources, movesIn, plannedMoves } from '../plan/moves';
import { checkImportedFrom, importsIn } from '../plan/imports';
import { ActionExecutor, Running } from './ActionExecutor';
import { Applying, ApplyVisitor, groupBy } from './ApplyVisitor';
import { LoadedConfig } from './ConfigLoader';
import { Pace } from './parallelism';
import { ProvisionerPrint } from './ProvisionerRunner';
import { RunEvent } from './RunEvent';
import { Approved, Checked, checkActionsMatch, checkOutputsMatch, dataNamed, plannedOutputs } from './savedPlanChecks';
import { streamed } from './streamed';
import { Step, walkTogether } from './walkTogether';

/** In declared order, so the state does not depend on which resolved first; one not reached keeps its old value. */
function holdOutputs(state: State, { resolved, declared }: Applying): void {
  state.outputs = Object.fromEntries(declared.filter((name) => resolved.has(name)).map((name) => [name, resolved.get(name)!]));
}

/** Held until nothing else runs, so a reader that stops at a failure cannot cut an action short. */
const isFailure = (event: RunEvent) => event.type === 'failed';

/** State is written whole before the first action and after the last; each action in between records its own address, so a killed run loses nothing done before it. */
export class PlanRunner {
  constructor(
    private stateManager: StateManager,
    private executor: ActionExecutor,
    private visitor: ApplyVisitor,
    private instances: Instances
  ) {}

  async *run(saved: Approved, config: LoadedConfig, graph: Graph<GraphNode>, state: State, pace: Pace): AsyncGenerator<RunEvent> {
    const { actions } = saved;
    checkActionsMatch(actions, graph, this.instances);
    const outputs = plannedOutputs(saved, state);
    checkOutputsMatch(outputs, config.mainProgram);
    const checked = { outputs, named: dataNamed(saved, graph) };
    checkMovedFrom(actions, movesIn(config.loadedModules), state);
    checkImportedFrom(actions, importsIn(config.loadedModules));
    // Every move first, as the plan made them, so each entry and every dependency on it is at its new address.
    moveResources(state, plannedMoves(actions));
    // Then every import, at the address the moves left free.
    Object.assign(state.resources, copyResources(saved.imported));
    this.executor.expect(actions, state);

    const order = applyGraph(graph, actions, state);
    // The refreshed resources, the moves and the imports, which no action records.
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

    const actions = yield* this.visitor.visit(key, node, applying, state);
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

  private async *step(action: PlanAction, state: State, signal?: AbortSignal, running: Running = {}): AsyncGenerator<RunEvent, boolean> {
    if (signal?.aborted) return false;

    // A no-op that changes nothing in state is not reported, but its dependencies are saved.
    const quiet = !changesState(action);
    if (!quiet) yield { type: 'started', action };

    const key = Address.of(action).toString();
    const held = Object.hasOwn(state.resources, key);
    const lost = () => held && !Object.hasOwn(state.resources, key);
    if (!(yield* this.attempt(action, state, (print) => this.executor.execute(action, state, { ...running, print }), lost))) return false;

    await this.stateManager.record(state, key);
    if (quiet) return true;

    yield { type: 'applied', action };
    return true;
  }

  /** Reported as it happens: the run may stop before the replace makes its new object. */
  private async *destroyFirst(action: PlanAction, state: State, signal?: AbortSignal): AsyncGenerator<RunEvent, boolean> {
    if (signal?.aborted) return false;
    if (!(yield* this.attempt(action, state, (print) => this.executor.destroy(action, state, print)))) return false;

    await this.stateManager.record(state, Address.of(action).toString());
    yield { type: 'destroyed', action };
    return true;
  }

  /** `lost` says whether the failed change destroyed the object, as a replace does before its create. What a provisioner prints is given as it comes. */
  private async *attempt(action: PlanAction, state: State, change: (print: ProvisionerPrint) => Promise<void>, lost = () => false): AsyncGenerator<RunEvent, boolean> {
    try {
      yield* streamed<RunEvent, void>((emit) => change((provisioner, line) => emit({ type: 'printed', action, provisioner, line })));
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
}
