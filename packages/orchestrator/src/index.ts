import { emptyState, Provider, Resource, Schema, State } from '@clay/contracts';
import { Graph } from '@clay/graph';
import { outputChanges, plan, Plan } from '@clay/planner';
import { StateManager } from '@clay/state';

import { checkApplyOrder } from './plan/applyGraph';
import { asError } from './asError';
import { GraphNode } from './graph/DependencyGraphBuilder';
import { DesiredState, Walk } from './plan/DesiredStateBuilder';
import { checkRead, heldBy, hidingReason } from './providers/providerResult';
import { checkAttributes } from './checks/checkAttributes';
import { checkPreventDestroy } from './checks/preventDestroy';
import { checkSameObjects } from './checks/sameObject';
import { ConfigFiles } from './config/ConfigFiles';
import { ProviderRegistry } from './providers/ProviderRegistry';
import { newRun, Run } from './run/Run';
import { RunEvent } from './run/RunEvent';
import { checkParallelism, DEFAULT_PARALLELISM } from './run/parallelism';
import { plainOf } from './values/Value';

export type { RunEvent } from './run/RunEvent';
export { DiskFiles, InMemoryFiles, RecordingFiles } from './config/ConfigFiles';
export type { ConfigFiles } from './config/ConfigFiles';
export { DEFAULT_PARALLELISM } from './run/parallelism';

export interface RunOptions {
  /** How many actions of a layer run at once. */
  parallelism?: number;
  /** Once it aborts, no action starts and the ones running are waited for and saved. A run stopped short ends without `done`. */
  signal?: AbortSignal;
}

/** A move changes the map, never a list in it, so a copy of the map is its own. */
function copyDeposed(deposed: State['deposed']): Pick<State, 'deposed'> {
  return deposed ? { deposed: { ...deposed } } : {};
}

/** Plan and apply move entries and rewrite dependencies, so each works on its own copy. */
function copyResources(resources: Record<string, Resource>): Record<string, Resource> {
  return Object.fromEntries(Object.entries(resources).map(([key, resource]) => [key, { ...resource }]));
}

export class Orchestrator {
  constructor(
    private stateManager: StateManager,
    private providers: ProviderRegistry,
    private newRun: () => Run
  ) {}

  static create(stateManager: StateManager, files: ConfigFiles): Orchestrator {
    const providers = new ProviderRegistry();
    return new Orchestrator(stateManager, providers, () => newRun(stateManager, providers, files));
  }

  registerProvider(provider: Provider): void {
    this.providers.register(provider);
  }

  /** A plan never writes state, even what the refresh read. */
  async plan(configContent: string, { refresh = true }: { refresh?: boolean } = {}): Promise<Plan> {
    const prevRun = await this.stateManager.read();
    const prior = refresh ? await this.refresh(prevRun) : prevRun;
    // Planning applies count moves to a copy; the plan keeps the resources at their old addresses.
    const currentState = { ...prior, resources: copyResources(prior.resources), ...copyDeposed(prior.deposed) };
    const { resources: desiredResources, outputs, dataSources, dataSensitive, readAtApply, graph } = await this.resolveAndCheck(configContent, currentState, 'plan');

    const actions = plan(desiredResources, currentState);
    checkPreventDestroy(actions, desiredResources, currentState.resources);
    await checkSameObjects(actions, desiredResources, currentState, this.providers);
    checkApplyOrder(graph, actions, currentState, desiredResources);
    // The refresh only drops resources, so prior has no type prevRun lacks.
    const held = [...actions, ...Object.values(prevRun.resources)];

    return {
      serial: prevRun.serial,
      actions,
      outputs: outputChanges(currentState.outputs ?? {}, outputs),
      prevRun: prevRun.resources,
      prior: prior.resources,
      schemas: await this.schemasOf(held.map((resource) => resource.resourceType)),
      dataSources,
      ...(Object.keys(dataSensitive).length > 0 && { dataSensitive }),
      readAtApply,
    };
  }

  private async schemasOf(types: string[]): Promise<Record<string, Schema>> {
    const unique = [...new Set(types)];
    return Object.fromEntries(await Promise.all(unique.map(async (type) => [type, await this.providers.schema(type)] as const)));
  }

  /** Plans against an empty state and reads no data source, so what a resource or a data source gives is unknown and everything else is checked. */
  async validate(configContent: string): Promise<void> {
    await this.resolveAndCheck(configContent, emptyState(), 'check');
  }

  /** Holds the state lock. A state written since the plan was made is refused, since the approved plan no longer matches it. */
  async *runPlan(saved: Plan, configContent: string, { parallelism = DEFAULT_PARALLELISM, signal }: RunOptions = {}): AsyncGenerator<RunEvent> {
    checkParallelism(parallelism);
    await this.stateManager.lock();

    // Released however the run ends: done, failed, thrown, or abandoned by the caller.
    try {
      const state = await this.stateManager.read();
      if (state.serial !== saved.serial) throw new Error('The state has changed since the plan was made. Plan again.');
      // The actions were planned against the refreshed resources, so they run on those.
      state.resources = copyResources(saved.prior);

      const { loader, graphBuilder, runner } = this.newRun();
      const config = await loader.load(configContent);
      const graph = graphBuilder.buildExecutionGraph(config.loadedResources, config.loadedModules);
      yield* runner.run(saved, config, graph, state, { parallelism, signal });
    } finally {
      await this.stateManager.unlock();
    }
  }

  /** A resource the provider no longer finds is dropped; the plan recreates it if the configuration still has it. */
  private async refresh(state: State): Promise<State> {
    const resources: State['resources'] = {};

    for (const [key, resource] of Object.entries(state.resources)) {
      const attributes = await this.readBack(key, resource);
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

  private async resolveAndCheck(configContent: string, state: State, walk: Walk): Promise<DesiredState & { graph: Graph<GraphNode> }> {
    const { loader, graphBuilder, writtenCheck, desiredStateBuilder } = this.newRun();
    const { loadedResources, loadedModules, schemas } = await loader.load(configContent);

    const graph = graphBuilder.buildExecutionGraph(loadedResources, loadedModules);
    checkAttributes(loadedResources, schemas);
    await writtenCheck.check(loadedResources, loadedModules, graph);
    return { ...(await desiredStateBuilder.build(loadedResources, graph, state, schemas, walk)), graph };
  }
}
