import { Provider, Provisioner, Schema } from '@clay/provider';
import { emptyState, Resource, State } from '@clay/core';
import { Graph } from '@clay/graph';
import { Statement } from '@clay/parser';
import { outputChanges, plan, Plan, VariableInput } from '@clay/planner';
import { DEFAULT_WORKSPACE, StateManager } from '@clay/state';

import { checkApplyOrder } from './plan/applyGraph';
import { asError } from './asError';
import { GraphNode } from './graph/DependencyGraphBuilder';
import { DesiredState } from './plan/DesiredStateBuilder';
import { Walk } from './plan/PlanReader';
import { applyMoves, checkMovedAway, copyForMoves, copyResources, Moves, movesIn } from './plan/moves';
import { checkImports, Imports, importsIn } from './plan/imports';
import { Refresh } from './plan/refresh';
import { checkRead, heldBy, hidingReason } from './providers/providerResult';
import { checkAttributes } from './checks/checkAttributes';
import { checkPreventDestroy } from './checks/preventDestroy';
import { checkSameObjects } from './checks/sameObject';
import { ConfigFiles } from './config/ConfigFiles';
import { inputsFor } from './config/givenValues';
import { RootValues } from './config/ModuleLoader';
import { ProviderRegistry } from './providers/ProviderRegistry';
import { ProvisionerRegistry } from './providers/ProvisionerRegistry';
import { newRun, Run } from './run/Run';
import { RunEvent } from './run/RunEvent';
import { checkParallelism, DEFAULT_PARALLELISM } from './run/parallelism';
import { inOrder, Limit } from './providers/Limit';
import { plainOf } from './values/Value';

export interface PlanOptions {
  /** Whether each resource is read from its provider first. */
  refresh?: boolean;
  /** How many calls to providers run at once. */
  parallelism?: number;
  /** Plans for a root module that declares nothing, so every object in state is destroyed. */
  destroy?: boolean;
  /** Values for root variables from outside the configuration, in order; a destroy reads none. */
  variables?: VariableInput[];
}

/** What a load is given: the root module in place of its files, and the values of its variables. */
interface Source {
  root?: Statement[];
  values?: RootValues;
}

/**
 * A destroy reads no value from the configuration, so a variable it lacks or a value it cannot work out does not stop it. Its root
 * declares no variable, so it takes no value given for one.
 */
const sourceOf = (destroy: boolean | undefined, variables: VariableInput[] = []): Source => (destroy ? { root: [] } : { values: { inputs: variables } });

/** Kept in the plan, so the apply reads the values the plan read, and no other value the environment held. */
function keptInputs(destroy: boolean, root: Statement[], given: VariableInput[]): { variables?: VariableInput[] } {
  const variables = destroy ? [] : inputsFor(root, given);
  return variables.length > 0 ? { variables } : {};
}

/** What a walk records as it goes. */
interface Steps {
  moves: Moves;
  imports: Imports;
  refresh?: Refresh;
}

export interface RunOptions {
  /** How many actions run at once. */
  parallelism?: number;
  /** Once it aborts, no action starts and the ones running are waited for and saved. A run stopped short ends without `done`. */
  signal?: AbortSignal;
}

/** A plan made with no state written yet is held to none being written since. */
function checkSameState(state: State, saved: Plan): void {
  if (saved.lineage !== undefined && state.lineage !== saved.lineage) throw new Error('The plan was made against another state. Plan again.');
  if (state.lineage !== saved.lineage || state.serial !== saved.serial) throw new Error('The state has changed since the plan was made. Plan again.');
}

export class Orchestrator {
  constructor(
    private stateManager: StateManager,
    private providers: ProviderRegistry,
    private provisioners: ProvisionerRegistry,
    private newRun: (limit: Limit, workspace: string | undefined) => Run,
    private workspace: string
  ) {}

  static create(stateManager: StateManager, files: ConfigFiles, workspace: string = DEFAULT_WORKSPACE): Orchestrator {
    const providers = new ProviderRegistry();
    const provisioners = new ProvisionerRegistry();
    return new Orchestrator(stateManager, providers, provisioners, (limit, name) => newRun(stateManager, { providers, provisioners }, files, limit, name), workspace);
  }

  registerProvider(provider: Provider): void {
    this.providers.register(provider);
  }

  registerProvisioner(provisioner: Provisioner): void {
    this.provisioners.register(provisioner);
  }

  /** Under the state lock the caller holds, so no run writes while it reads. A plan never writes state, even what the refresh read. */
  async plan({ refresh = true, parallelism = DEFAULT_PARALLELISM, destroy = false, variables = [] }: PlanOptions = {}): Promise<Plan> {
    checkParallelism(parallelism);
    this.stateManager.requireLock('A plan');
    const limit = new Limit(parallelism);
    const prevRun = await this.stateManager.read();
    // Planning applies the moves to a copy; the plan keeps the resources at their old addresses.
    const currentState = copyForMoves(prevRun);
    const steps = this.planSteps(limit, refresh);
    const { moves, imports } = steps;
    const {
      resources: desiredResources,
      outputs,
      dataSources,
      dataSensitive,
      readAtApply,
      graph,
      root,
    } = await this.resolveAndCheck(currentState, 'plan', steps, limit, sourceOf(destroy, variables));
    const prior = await this.refreshRest(steps, currentState, prevRun);

    imports.adopt(currentState, desiredResources);
    const actions = plan(
      desiredResources,
      currentState,
      (address) => moves.originOf(address),
      (address) => imports.idOf(address)
    );
    checkPreventDestroy(actions, desiredResources, currentState.resources);
    await checkSameObjects(actions, desiredResources, currentState, this.providers, limit);
    checkApplyOrder(graph, actions, currentState, desiredResources);
    // The refresh only drops resources, so prior has no type prevRun lacks.
    const types = [...actions, ...Object.values(prevRun.resources)].map((resource) => resource.resourceType);

    return {
      serial: prevRun.serial,
      lineage: prevRun.lineage,
      actions,
      outputs: outputChanges(currentState.outputs ?? {}, outputs),
      prevRun: prevRun.resources,
      prior: prior.resources,
      imported: imports.imported(currentState),
      schemas: await this.schemasOf(types, limit),
      dataSources,
      ...(Object.keys(dataSensitive).length > 0 && { dataSensitive }),
      readAtApply,
      ...(destroy && { destroy: true }),
      ...keptInputs(destroy, root, variables),
    };
  }

  private planSteps(limit: Limit, refresh: boolean): Steps {
    const moves = new Moves();
    const imports = new Imports(this.providers, limit, (key, resource) => this.readBack(key, resource));
    if (!refresh) return { moves, imports };

    return { moves, imports, refresh: new Refresh(limit, moves, (key, resource) => this.readBack(key, resource)) };
  }

  /** Reads the objects no block reached, and gives what the refresh read at the addresses the state held them at. */
  private async refreshRest({ refresh }: Steps, state: State, prevRun: State): Promise<State> {
    if (!refresh) return prevRun;

    await refresh.rest(state);
    return refresh.prior(prevRun);
  }

  private async schemasOf(types: string[], limit: Limit): Promise<Record<string, Schema>> {
    const unique = [...new Set(types)];
    return Object.fromEntries(await inOrder(unique.map(async (type) => [type, await limit.run(() => this.providers.schema(type))] as const)));
  }

  /**
   * Plans against an empty state and reads no data source, so what a resource or a data source gives is unknown and everything else is checked.
   * A root variable with no value is unknown too, since only a plan is given one.
   */
  async validate(): Promise<void> {
    const limit = new Limit(DEFAULT_PARALLELISM);
    const imports = new Imports(this.providers, limit, (key, resource) => this.readBack(key, resource));
    await this.resolveAndCheck(emptyState(), 'check', { moves: new Moves(), imports }, limit, { values: { unset: 'unknown' } });
  }

  /**
   * Under the state lock the caller holds, from the plan to the end of the run. A state written since the plan was made, or another state, is
   * refused, since the approved plan no longer matches it.
   */
  async *runPlan(saved: Plan, { parallelism = DEFAULT_PARALLELISM, signal }: RunOptions = {}): AsyncGenerator<RunEvent> {
    checkParallelism(parallelism);
    this.stateManager.requireLock('A run');
    const state = await this.stateManager.read();
    checkSameState(state, saved);
    // The actions were planned against the refreshed resources, so they run on those.
    state.resources = copyResources(saved.prior);

    const { loader, graphBuilder, runner } = this.newRun(new Limit(parallelism), this.workspace);
    const { root, values } = sourceOf(saved.destroy, saved.variables);
    const config = await loader.load(root, values);
    const graph = graphBuilder.buildExecutionGraph(config.loadedResources, config.loadedModules);
    yield* runner.run(saved, config, graph, state, { parallelism, signal });
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

  /**
   * Applies every move to `state` before anything reads it, each import as the walk reaches its instance and each refresh as it reaches its
   * block; a check only reads the ids.
   */
  private async resolveAndCheck(
    state: State,
    walk: Walk,
    { moves, imports, refresh }: Steps,
    limit: Limit,
    { root, values }: Source
  ): Promise<DesiredState & { graph: Graph<GraphNode>; root: Statement[] }> {
    const { loader, graphBuilder, writtenCheck, desiredStateBuilder, modules } = this.newRun(limit, walk === 'plan' ? this.workspace : undefined);
    const { mainProgram, loadedResources, loadedModules, schemas } = await loader.load(root, values);

    const graph = graphBuilder.buildExecutionGraph(loadedResources, loadedModules);
    checkAttributes(loadedResources, schemas);
    await writtenCheck.check(loadedResources, loadedModules, graph);
    const moved = movesIn(loadedModules);
    const importing = importsIn(loadedModules);
    const importsTo = checkImports(importing, { resources: loadedResources, modules: loadedModules }, this.providers);
    applyMoves(moved, state, moves);
    imports.take(importsTo);
    const desired = await desiredStateBuilder.build(loadedResources, graph, state, schemas, walk, moves, imports, refresh);
    const declared = loadedModules.flatMap(({ address }) => (address.isRoot() ? [] : modules.of(address)));
    checkMovedAway(moved, desired.resources, declared);
    // A check may not know a count or for_each, so it makes no instance of the block.
    if (walk === 'plan') imports.checkPlanned(desired.resources);
    return { ...desired, graph, root: mainProgram };
  }
}
