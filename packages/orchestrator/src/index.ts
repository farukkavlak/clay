import { emptyState, Provider, Provisioner, Resource, Schema, State } from '@clay/contracts';
import { Graph } from '@clay/graph';
import { outputChanges, plan, Plan } from '@clay/planner';
import { StateManager } from '@clay/state';

import { checkApplyOrder } from './plan/applyGraph';
import { asError } from './asError';
import { GraphNode } from './graph/DependencyGraphBuilder';
import { DesiredState, Walk } from './plan/DesiredStateBuilder';
import { applyMoves, checkMovedAway, copyForMoves, copyResources, Moves, movesIn } from './plan/moves';
import { checkRead, heldBy, hidingReason } from './providers/providerResult';
import { checkAttributes } from './checks/checkAttributes';
import { checkPreventDestroy } from './checks/preventDestroy';
import { checkSameObjects } from './checks/sameObject';
import { ConfigFiles } from './config/ConfigFiles';
import { ProviderRegistry } from './providers/ProviderRegistry';
import { ProvisionerRegistry } from './providers/ProvisionerRegistry';
import { newRun, Run } from './run/Run';
import { RunEvent } from './run/RunEvent';
import { checkParallelism, DEFAULT_PARALLELISM } from './run/parallelism';
import { inOrder, Limit } from './providers/Limit';
import { plainOf } from './values/Value';

export type { RunEvent } from './run/RunEvent';
export { DiskFiles, InMemoryFiles, RecordingFiles } from './config/ConfigFiles';
export type { ConfigFiles } from './config/ConfigFiles';
export { DEFAULT_PARALLELISM } from './run/parallelism';

export interface PlanOptions {
  /** Whether each resource is read from its provider first. */
  refresh?: boolean;
  /** How many calls to providers run at once. */
  parallelism?: number;
}

export interface RunOptions {
  /** How many actions run at once. */
  parallelism?: number;
  /** Once it aborts, no action starts and the ones running are waited for and saved. A run stopped short ends without `done`. */
  signal?: AbortSignal;
}

export class Orchestrator {
  constructor(
    private stateManager: StateManager,
    private providers: ProviderRegistry,
    private provisioners: ProvisionerRegistry,
    private newRun: (limit: Limit) => Run
  ) {}

  static create(stateManager: StateManager, files: ConfigFiles): Orchestrator {
    const providers = new ProviderRegistry();
    const provisioners = new ProvisionerRegistry();
    return new Orchestrator(stateManager, providers, provisioners, (limit) => newRun(stateManager, { providers, provisioners }, files, limit));
  }

  registerProvider(provider: Provider): void {
    this.providers.register(provider);
  }

  registerProvisioner(provisioner: Provisioner): void {
    this.provisioners.register(provisioner);
  }

  /** A plan never writes state, even what the refresh read. */
  async plan({ refresh = true, parallelism = DEFAULT_PARALLELISM }: PlanOptions = {}): Promise<Plan> {
    checkParallelism(parallelism);
    const limit = new Limit(parallelism);
    const prevRun = await this.stateManager.read();
    const prior = refresh ? await this.refresh(prevRun, limit) : prevRun;
    // Planning applies the moves to a copy; the plan keeps the resources at their old addresses.
    const currentState = copyForMoves(prior);
    const moves = new Moves();
    const { resources: desiredResources, outputs, dataSources, dataSensitive, readAtApply, graph } = await this.resolveAndCheck(currentState, 'plan', moves, limit);

    const actions = plan(desiredResources, currentState, (address) => moves.originOf(address));
    checkPreventDestroy(actions, desiredResources, currentState.resources);
    await checkSameObjects(actions, desiredResources, currentState, this.providers, limit);
    checkApplyOrder(graph, actions, currentState, desiredResources);
    // The refresh only drops resources, so prior has no type prevRun lacks.
    const types = [...actions, ...Object.values(prevRun.resources)].map((resource) => resource.resourceType);

    return {
      serial: prevRun.serial,
      actions,
      outputs: outputChanges(currentState.outputs ?? {}, outputs),
      prevRun: prevRun.resources,
      prior: prior.resources,
      schemas: await this.schemasOf(types, limit),
      dataSources,
      ...(Object.keys(dataSensitive).length > 0 && { dataSensitive }),
      readAtApply,
    };
  }

  private async schemasOf(types: string[], limit: Limit): Promise<Record<string, Schema>> {
    const unique = [...new Set(types)];
    return Object.fromEntries(await inOrder(unique.map(async (type) => [type, await limit.run(() => this.providers.schema(type))] as const)));
  }

  /** Plans against an empty state and reads no data source, so what a resource or a data source gives is unknown and everything else is checked. */
  async validate(): Promise<void> {
    await this.resolveAndCheck(emptyState(), 'check', new Moves(), new Limit(DEFAULT_PARALLELISM));
  }

  /** Holds the state lock. A state written since the plan was made is refused, since the approved plan no longer matches it. */
  async *runPlan(saved: Plan, { parallelism = DEFAULT_PARALLELISM, signal }: RunOptions = {}): AsyncGenerator<RunEvent> {
    checkParallelism(parallelism);
    await this.stateManager.lock();

    // Released however the run ends: done, failed, thrown, or abandoned by the caller.
    try {
      const state = await this.stateManager.read();
      if (state.serial !== saved.serial) throw new Error('The state has changed since the plan was made. Plan again.');
      // The actions were planned against the refreshed resources, so they run on those.
      state.resources = copyResources(saved.prior);

      const { loader, graphBuilder, runner } = this.newRun(new Limit(parallelism));
      const config = await loader.load();
      const graph = graphBuilder.buildExecutionGraph(config.loadedResources, config.loadedModules);
      yield* runner.run(saved, config, graph, state, { parallelism, signal });
    } finally {
      await this.stateManager.unlock();
    }
  }

  /** A resource the provider no longer finds is dropped; the plan recreates it if the configuration still has it. */
  private async refresh(state: State, limit: Limit): Promise<State> {
    const held = Object.entries(state.resources);
    const read = await inOrder(held.map(([key, resource]) => limit.run(() => this.readBack(key, resource))));
    const resources: State['resources'] = {};

    for (const [index, [key, resource]] of held.entries()) {
      const attributes = read[index];
      if (attributes !== null) resources[key] = { ...resource, attributes };
    }

    return { ...state, resources };
  }

  private async readBack(key: string, resource: Resource): Promise<Record<string, unknown> | null> {
    try {
      const provider = this.providers.get(resource.resourceType);
      const read = await hidingReason(resource.resourceType, resource.sensitive ?? [], () => provider.read(resource.resourceType, resource.attributes), 'to read');
      if (read === null) return null;

      const schema = await this.providers.schema(resource.resourceType);
      const held = plainOf(heldBy(resource.resourceType, 'read', schema, read));
      checkRead(resource.resourceType, schema, held);
      return held;
    } catch (error) {
      throw new Error(`${key}: ${asError(error).message}`, { cause: error });
    }
  }

  /** Applies every move to `state` before anything reads it, and records each in `moves`. */
  private async resolveAndCheck(state: State, walk: Walk, moves: Moves, limit: Limit): Promise<DesiredState & { graph: Graph<GraphNode> }> {
    const { loader, graphBuilder, writtenCheck, desiredStateBuilder, modules } = this.newRun(limit);
    const { loadedResources, loadedModules, schemas } = await loader.load();

    const graph = graphBuilder.buildExecutionGraph(loadedResources, loadedModules);
    checkAttributes(loadedResources, schemas);
    await writtenCheck.check(loadedResources, loadedModules, graph);
    const moved = movesIn(loadedModules);
    applyMoves(moved, state, moves);
    const desired = await desiredStateBuilder.build(loadedResources, graph, state, schemas, walk, moves);
    const declared = loadedModules.flatMap(({ address }) => (address.isRoot() ? [] : modules.of(address)));
    checkMovedAway(moved, desired.resources, declared);
    return { ...desired, graph };
  }
}
