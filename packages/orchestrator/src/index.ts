import { Address, emptyState, IProvider, ISchema, IState } from '@clay/contracts';
import { DesiredResource, isUnknown, outputChanges, plan, Plan } from '@clay/planner';
import { StateManager } from '@clay/state';

import { asError } from './asError';
import { ActionExecutor } from './components/ActionExecutor';
import { ConfigLoader } from './components/ConfigLoader';
import { DependencyGraphBuilder } from './components/DependencyGraphBuilder';
import { DesiredStateBuilder } from './components/DesiredStateBuilder';
import { ModuleLoader } from './components/ModuleLoader';
import { PlanRunner } from './components/PlanRunner';
import { ConfigFiles } from './ConfigFiles';
import { ProviderRegistry } from './ProviderRegistry';
import { ReferenceResolver } from './resolvers/ReferenceResolver';
import { ReferenceScanner } from './resolvers/ReferenceScanner';
import { RunEvent } from './RunEvent';
import { ScopeManager } from './scope/ScopeManager';

export type { RunEvent } from './RunEvent';
export { DiskFiles, InMemoryFiles, RecordingFiles } from './ConfigFiles';
export type { ConfigFiles } from './ConfigFiles';

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
    const resolver = new ReferenceResolver(scopes, dataSources);
    const scanner = new ReferenceScanner(scopes);
    const graphBuilder = new DependencyGraphBuilder(scopes, scanner);

    return new Orchestrator(
      stateManager,
      providers,
      new ConfigLoader(new ModuleLoader(files, scopes), scopes, dataSources, resolver, providers),
      graphBuilder,
      new DesiredStateBuilder(scopes, scanner, resolver, graphBuilder),
      new PlanRunner(stateManager, new ActionExecutor(providers, resolver), scopes, resolver)
    );
  }

  registerProvider(provider: IProvider): void {
    this.providers.register(provider);
  }

  async plan(configContent: string): Promise<Plan> {
    const currentState = await this.stateManager.read();
    const { desiredResources, outputs, schemas } = await this.resolveAndCheck(configContent, currentState);

    return { serial: currentState.serial, actions: plan(desiredResources, currentState, schemas), outputs: outputChanges(currentState.outputs ?? {}, outputs) };
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

      const config = await this.loader.load(configContent, state);
      const graph = this.graphBuilder.buildExecutionGraph(config.loadedResources, config.loadedModules);
      yield* this.runner.run(saved.actions, config, graph, state);
    } finally {
      await this.stateManager.unlock();
    }
  }

  private async resolveAndCheck(
    configContent: string,
    state: IState
  ): Promise<{ desiredResources: DesiredResource[]; outputs: Record<string, unknown>; schemas: Record<string, ISchema> }> {
    const { loadedResources, loadedModules } = await this.loader.load(configContent, state);

    const graph = this.graphBuilder.buildExecutionGraph(loadedResources, loadedModules);
    const { resources: desiredResources, outputs } = this.desiredStateBuilder.build(loadedResources, graph, state);

    return { desiredResources, outputs, schemas: await this.checkWithProviders(desiredResources) };
  }

  /** What a provider can refuse before anything runs is refused here. A value not known yet is checked once the run knows it. */
  private async checkWithProviders(desired: DesiredResource[]): Promise<Record<string, ISchema>> {
    const schemas: Record<string, ISchema> = {};

    for (const resource of desired) {
      const type = resource.block.resourceType;
      const provider = this.providers.get(type);

      schemas[type] ??= await provider.getSchema(type);
      if (Object.values(resource.attributes).some((value) => isUnknown(value))) continue;

      try {
        await provider.validate(type, resource.attributes);
      } catch (error) {
        throw new Error(`${Address.of(resource.block).toString()}: ${asError(error).message}`, { cause: error });
      }
    }

    return schemas;
  }
}
