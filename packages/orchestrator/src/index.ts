import { emptyState, Provider, Resource, Schema, State } from '@clay/contracts';
import { outputChanges, plan, Plan } from '@clay/planner';
import { StateManager } from '@clay/state';

import { asError } from './asError';
import { ActionExecutor } from './components/ActionExecutor';
import { ConfigLoader } from './components/ConfigLoader';
import { DataSourceReader } from './components/DataSourceReader';
import { DependencyGraphBuilder } from './components/DependencyGraphBuilder';
import { DesiredState, DesiredStateBuilder } from './components/DesiredStateBuilder';
import { ModuleLoader } from './components/ModuleLoader';
import { PlanRunner } from './components/PlanRunner';
import { ResourcePlanner } from './components/ResourcePlanner';
import { WrittenCheck } from './components/WrittenCheck';
import { checkRead, heldBy } from './providerResult';
import { Instances } from './Instances';
import { ModuleInstances } from './ModuleInstances';
import { Planned } from './Planned';
import { checkAttributes } from './checkAttributes';
import { ConfigFiles } from './ConfigFiles';
import { ProviderRegistry } from './ProviderRegistry';
import { ReferenceResolver } from './resolvers/ReferenceResolver';
import { ReferenceScanner } from './resolvers/ReferenceScanner';
import { RunEvent } from './RunEvent';
import { ScopeManager } from './scope/ScopeManager';
import { plainOf, Value } from './Value';

export type { RunEvent } from './RunEvent';
export { DiskFiles, InMemoryFiles, RecordingFiles } from './ConfigFiles';
export type { ConfigFiles } from './ConfigFiles';

/** Plan and apply move entries and rewrite dependencies, so each works on its own copy. */
function copyResources(resources: Record<string, Resource>): Record<string, Resource> {
  return Object.fromEntries(Object.entries(resources).map(([key, resource]) => [key, { ...resource }]));
}

export class Orchestrator {
  constructor(
    private stateManager: StateManager,
    private providers: ProviderRegistry,
    private loader: ConfigLoader,
    private graphBuilder: DependencyGraphBuilder,
    private writtenCheck: WrittenCheck,
    private desiredStateBuilder: DesiredStateBuilder,
    private runner: PlanRunner
  ) {}

  static create(stateManager: StateManager, files: ConfigFiles): Orchestrator {
    const providers = new ProviderRegistry();
    const scopes = new ScopeManager();
    const dataSources = new Map<string, Record<string, Value>>();
    const schemas = new Map<string, Schema>();
    const dataSchemas = new Map<string, Schema>();
    const instances = new Instances();
    const modules = new ModuleInstances();
    const planned = new Planned();
    const resolver = new ReferenceResolver(scopes, dataSources, schemas, dataSchemas, instances, modules, planned);
    const scanner = new ReferenceScanner(modules);
    const graphBuilder = new DependencyGraphBuilder(scanner, instances, modules);
    const resourcePlanner = new ResourcePlanner(providers);
    const reader = new DataSourceReader(providers, dataSchemas, dataSources);

    return new Orchestrator(
      stateManager,
      providers,
      new ConfigLoader(new ModuleLoader(files, scopes), scopes, dataSources, schemas, dataSchemas, resolver, providers, instances, modules, planned),
      graphBuilder,
      new WrittenCheck(resolver, scopes, schemas, dataSchemas),
      new DesiredStateBuilder(scopes, scanner, resolver, graphBuilder, instances, modules, planned, resourcePlanner, reader),
      new PlanRunner(stateManager, new ActionExecutor(providers, resolver, resourcePlanner), scopes, resolver, instances, modules, reader)
    );
  }

  registerProvider(provider: Provider): void {
    this.providers.register(provider);
  }

  /** A plan never writes state, even what the refresh read. */
  async plan(configContent: string, { refresh = true }: { refresh?: boolean } = {}): Promise<Plan> {
    const prevRun = await this.stateManager.read();
    const prior = refresh ? await this.refresh(prevRun) : prevRun;
    // Planning applies count moves to a copy; the plan keeps the resources at their old addresses.
    const currentState = { ...prior, resources: copyResources(prior.resources) };
    const { resources: desiredResources, outputs, dataSources, readAtApply } = await this.resolveAndCheck(configContent, currentState);

    const actions = plan(desiredResources, currentState);
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
      readAtApply,
    };
  }

  private async schemasOf(types: string[]): Promise<Record<string, Schema>> {
    const unique = [...new Set(types)];
    return Object.fromEntries(await Promise.all(unique.map(async (type) => [type, await this.providers.schema(type)] as const)));
  }

  /** Plans against an empty state, so resource values are unknown and everything else is checked. */
  async validate(configContent: string): Promise<void> {
    await this.resolveAndCheck(configContent, emptyState());
  }

  /** Holds the state lock. A state written since the plan was made is refused, since the approved plan no longer matches it. */
  async *runPlan(saved: Plan, configContent: string): AsyncGenerator<RunEvent> {
    await this.stateManager.lock();

    // Released however the run ends: done, failed, thrown, or abandoned by the caller.
    try {
      const state = await this.stateManager.read();
      if (state.serial !== saved.serial) throw new Error('The state has changed since the plan was made. Plan again.');
      // The actions were planned against the refreshed resources, so they run on those.
      state.resources = copyResources(saved.prior);

      const config = await this.loader.load(configContent);
      const graph = this.graphBuilder.buildExecutionGraph(config.loadedResources, config.loadedModules);
      yield* this.runner.run(saved, config, graph, state);
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
      const read = await provider.read(resource.resourceType, resource.attributes);
      if (read === null) return null;

      const schema = await this.providers.schema(resource.resourceType);
      const held = plainOf(heldBy(resource.resourceType, 'read', schema, read));
      checkRead(resource.resourceType, schema, held);
      return held;
    } catch (error) {
      throw new Error(`${key}: ${asError(error).message}`, { cause: error });
    }
  }

  private async resolveAndCheck(configContent: string, state: State): Promise<DesiredState> {
    const { loadedResources, loadedModules, schemas } = await this.loader.load(configContent);

    const graph = this.graphBuilder.buildExecutionGraph(loadedResources, loadedModules);
    checkAttributes(loadedResources, schemas);
    this.writtenCheck.check(loadedResources, loadedModules);
    return await this.desiredStateBuilder.build(loadedResources, graph, state, schemas);
  }
}
