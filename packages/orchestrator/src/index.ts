import { emptyState, Provider, Resource, Schema, State } from '@clay/contracts';
import { spell } from '@clay/parser';
import { DesiredResource, outputChanges, plan, Plan } from '@clay/planner';
import { StateManager } from '@clay/state';

import { asError } from './asError';
import { ActionExecutor } from './components/ActionExecutor';
import { ConfigLoader } from './components/ConfigLoader';
import { DependencyGraphBuilder } from './components/DependencyGraphBuilder';
import { DesiredStateBuilder } from './components/DesiredStateBuilder';
import { LoadedResource, ModuleLoader } from './components/ModuleLoader';
import { PlanRunner } from './components/PlanRunner';
import { ResourcePlanner } from './components/ResourcePlanner';
import { checkRead, checkSchema } from './providerResult';
import { Instances } from './Instances';
import { ModuleInstances } from './ModuleInstances';
import { Planned } from './Planned';
import { withPlace } from './place';
import { refuseComputedSet } from './refuseComputedSet';
import { ConfigFiles } from './ConfigFiles';
import { ProviderRegistry } from './ProviderRegistry';
import { ReferenceResolver } from './resolvers/ReferenceResolver';
import { ReferenceScanner } from './resolvers/ReferenceScanner';
import { RunEvent } from './RunEvent';
import { ScopeManager } from './scope/ScopeManager';

export type { RunEvent } from './RunEvent';
export { DiskFiles, InMemoryFiles, RecordingFiles } from './ConfigFiles';
export type { ConfigFiles } from './ConfigFiles';

/** Planning and running move entries and rewrite what each depends on, so each works on its own copy. */
function copyResources(resources: Record<string, Resource>): Record<string, Resource> {
  return Object.fromEntries(Object.entries(resources).map(([key, resource]) => [key, { ...resource }]));
}

export class Orchestrator {
  constructor(
    private stateManager: StateManager,
    private providers: ProviderRegistry,
    private loader: ConfigLoader,
    private graphBuilder: DependencyGraphBuilder,
    private desiredStateBuilder: DesiredStateBuilder,
    private runner: PlanRunner
  ) {}

  /** Builds the engine and everything it is made of, reading modules through `files` and the state through `stateManager`. */
  static create(stateManager: StateManager, files: ConfigFiles): Orchestrator {
    const providers = new ProviderRegistry();
    const scopes = new ScopeManager();
    const dataSources = new Map<string, Record<string, unknown>>();
    const instances = new Instances();
    const modules = new ModuleInstances();
    const planned = new Planned();
    const resolver = new ReferenceResolver(scopes, dataSources, instances, modules, planned);
    const scanner = new ReferenceScanner(modules);
    const graphBuilder = new DependencyGraphBuilder(scanner, instances, modules);

    return new Orchestrator(
      stateManager,
      providers,
      new ConfigLoader(new ModuleLoader(files, scopes), scopes, dataSources, resolver, providers, instances, modules, planned),
      graphBuilder,
      new DesiredStateBuilder(scopes, scanner, resolver, graphBuilder, instances, modules, planned, new ResourcePlanner(providers)),
      new PlanRunner(stateManager, new ActionExecutor(providers, resolver), scopes, resolver, instances, modules)
    );
  }

  registerProvider(provider: Provider): void {
    this.providers.register(provider);
  }

  /** Plans against each resource as its provider reads it now, unless `refresh` is false. What it reads is not written: a plan only looks. */
  async plan(configContent: string, { refresh = true }: { refresh?: boolean } = {}): Promise<Plan> {
    const prevRun = await this.stateManager.read();
    const prior = refresh ? await this.refresh(prevRun) : prevRun;
    // Planning moves what gained or lost count, so the actions are planned against the resources where they now are; the plan keeps them where they were.
    const currentState = { ...prior, resources: copyResources(prior.resources) };
    const { desiredResources, outputs } = await this.resolveAndCheck(configContent, currentState);

    return {
      serial: prevRun.serial,
      actions: plan(desiredResources, currentState),
      outputs: outputChanges(currentState.outputs ?? {}, outputs),
      prevRun: prevRun.resources,
      prior: prior.resources,
    };
  }

  /** Checks the configuration the way a plan would, against an empty state, so a value a resource would give is unknown and everything else is checked. */
  async validate(configContent: string): Promise<void> {
    await this.resolveAndCheck(configContent, emptyState());
  }

  /** Runs a plan under the state lock. The plan is what the caller saw and approved; a state written since would make it a different plan. */
  async *runPlan(saved: Plan, configContent: string): AsyncGenerator<RunEvent> {
    await this.stateManager.lock();

    // Released on the way out however the run ends: done, failed, thrown, or dropped by the caller.
    try {
      const state = await this.stateManager.read();
      if (state.serial !== saved.serial) throw new Error('The state has changed since the plan was made. Plan again.');
      // The actions were planned against what the refresh read, so that is what they run on and what is written.
      state.resources = copyResources(saved.prior);

      const config = await this.loader.load(configContent, state);
      const graph = this.graphBuilder.buildExecutionGraph(config.loadedResources, config.loadedModules);
      yield* this.runner.run(saved.actions, config, graph, state);
    } finally {
      await this.stateManager.unlock();
    }
  }

  /** A resource its provider no longer finds is left out; the plan makes it again if the configuration still has it. */
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
      if (read !== null) checkRead(resource.resourceType, await this.schemaOf(resource.resourceType), resource.attributes, read);

      return read;
    } catch (error) {
      throw new Error(`${key}: ${asError(error).message}`, { cause: error });
    }
  }

  private async resolveAndCheck(configContent: string, state: State): Promise<{ desiredResources: DesiredResource[]; outputs: Record<string, unknown> }> {
    const { loadedResources, loadedModules } = await this.loader.load(configContent, state);

    const graph = this.graphBuilder.buildExecutionGraph(loadedResources, loadedModules);
    const schemas = await this.schemasOf(loadedResources);
    refuseComputedSet(loadedResources, schemas);
    const { resources: desiredResources, outputs } = await this.desiredStateBuilder.build(loadedResources, graph, state, schemas);

    return { desiredResources, outputs };
  }

  /** Read before the values are, since a provider is asked to plan with what it computed kept from state where the configuration does not set it. */
  private async schemasOf(loaded: LoadedResource[]): Promise<Map<string, Schema>> {
    // A Map because a resource type may be named `constructor`: an object would already hold a value there, and the real schema would be dropped.
    const schemas = new Map<string, Schema>();

    for (const { block, address } of loaded) {
      const type = block.resourceType;
      if (schemas.has(type)) continue;

      try {
        schemas.set(type, await this.schemaOf(type));
      } catch (error) {
        throw withPlace(error, block.position, spell(block), address);
      }
    }

    return schemas;
  }

  private async schemaOf(type: string): Promise<Schema> {
    return checkSchema(type, await this.providers.get(type).getSchema(type));
  }
}
