import { IProvider, ISchema } from '@clay/contracts';
import { Graph } from '@clay/graph';
import { AttributeValue, Lexer, Parser, Statement } from '@clay/parser';
import { DesiredResource, hasChanges, isUnknown, outputChanges, plan, Plan, PlanAction, UNKNOWN } from '@clay/planner';
import { IState, StateManager } from '@clay/state';

import { Address } from './Address';
import { ConfigFiles } from './ConfigFiles';
import { ActionExecutor } from './components/ActionExecutor';
import { DependencyGraphBuilder, GraphNode, ValueNode } from './components/DependencyGraphBuilder';
import { LoadedModule, LoadedResource, ModuleLoader } from './components/ModuleLoader';
import { ReferenceResolver } from './resolvers/ReferenceResolver';
import { RunEvent } from './RunEvent';
import { ReferenceScanner } from './resolvers/ReferenceScanner';
import { UnresolvedReferenceError } from './resolvers/UnresolvedReferenceError';
import { ScopeManager } from './scope/ScopeManager';

export type { RunEvent } from './RunEvent';
export { Address } from './Address';
export { DiskFiles, InMemoryFiles, RecordingFiles } from './ConfigFiles';
export type { ConfigFiles } from './ConfigFiles';

export class Orchestrator {
  private providers: Map<string, IProvider> = new Map();
  private dataSources: Map<string, Record<string, unknown>> = new Map();
  private stateManager: StateManager;
  private scopeManager: ScopeManager;
  private referenceResolver: ReferenceResolver;
  private moduleLoader: ModuleLoader;
  private actionExecutor: ActionExecutor;
  private dependencyGraphBuilder: DependencyGraphBuilder;
  private referenceScanner: ReferenceScanner;

  constructor(stateManager: StateManager, files: ConfigFiles) {
    this.stateManager = stateManager;
    this.scopeManager = new ScopeManager();
    this.referenceResolver = new ReferenceResolver(this.scopeManager, this.dataSources);
    this.moduleLoader = new ModuleLoader(files, this.processVariables.bind(this), this.initializeChildVariables.bind(this), this.getAttributesMap.bind(this));
    this.referenceScanner = new ReferenceScanner(this.scopeManager);
    this.dependencyGraphBuilder = new DependencyGraphBuilder(this.scopeManager, this.referenceScanner);
    this.actionExecutor = new ActionExecutor(this.providers, this.convertAttributes.bind(this));
  }

  /**
   * Register a provider for specific resource types
   */
  registerProvider(provider: IProvider): void {
    for (const resourceType of provider.resources) {
      if (this.providers.has(resourceType)) throw new Error(`Provider for resource type "${resourceType}" already registered`);

      this.providers.set(resourceType, provider);
    }
  }

  /**
   * Process variable declarations for a specific scope
   */
  private processVariables(program: Statement[], address: Address): void {
    const scope = this.scopeManager.getScope(address);

    // A caller's input beats the default; neither one is a missing input, read or not.
    for (const stmt of program) {
      if (stmt.type !== 'Variable' || this.scopeManager.getVariable(scope, stmt.name)) continue;
      if (stmt.attributes.default === undefined) throw new Error(`${scope ? `${scope}: ` : ''}variable "${stmt.name}" has no value`);

      this.scopeManager.setVariable(scope, stmt.name, { value: stmt.attributes.default, context: address });
    }
  }

  private async processDataSources(program: Statement[], state: IState, scopeAddress: Address): Promise<void> {
    const scope = this.scopeManager.getScope(scopeAddress);

    for (const stmt of program)
      if (stmt.type === 'Data') {
        const provider = this.providers.get(stmt.dataSourceType);
        if (!provider) throw new Error(`Provider for data source type "${stmt.dataSourceType}" not registered`);

        // Resolve inputs (attributes)
        const inputs = this.convertAttributes(stmt.attributes, state, scopeAddress);

        // Validate inputs
        await provider.validate(stmt.dataSourceType, inputs);

        // Read data
        const resolvedAttributes = await provider.read(stmt.dataSourceType, inputs);

        // Store in dataSources map with scope prefix
        const dataSourceKey = scope ? `${scope}.${stmt.dataSourceType}.${stmt.name}` : `${stmt.dataSourceType}.${stmt.name}`;
        this.dataSources.set(dataSourceKey, resolvedAttributes);
      }
  }

  /**
   * Generate an execution plan without applying it
   */
  /**
   * Loads the full execution context (programs, modules, data sources)
   */
  private async loadContext(
    configContent: string,
    state: IState
  ): Promise<{
    mainProgram: Statement[];
    loadedResources: import('./components/ModuleLoader').LoadedResource[];
    loadedModules: LoadedModule[];
  }> {
    const lexer = new Lexer(configContent);
    const parser = new Parser(lexer.tokenize());
    const mainProgram = parser.parse() || [];

    this.scopeManager.clear();
    this.processVariables(mainProgram, new Address([], '', ''));

    const { resources: loadedResources, modules: loadedModules } = await this.moduleLoader.loadModuleTree(mainProgram);

    this.dataSources.clear();
    for (const mod of loadedModules) await this.processDataSources(mod.program, state, mod.address);

    return { mainProgram, loadedResources, loadedModules };
  }

  /**
   * Generate an execution plan without applying it
   */
  async plan(configContent: string): Promise<Plan> {
    const currentState = await this.stateManager.read();
    const { desiredResources, outputs, schemas } = await this.resolveAndCheck(configContent, currentState);

    return { serial: currentState.serial, actions: plan(desiredResources, currentState, schemas), outputs: outputChanges(currentState.outputs ?? {}, outputs) };
  }

  /** Checks the configuration the way a plan would, against an empty state, so a value a resource would give is unknown and everything else is checked. */
  async validate(configContent: string): Promise<void> {
    await this.resolveAndCheck(configContent, { version: 1, serial: 0, resources: {} });
  }

  private async resolveAndCheck(
    configContent: string,
    state: IState
  ): Promise<{ desiredResources: DesiredResource[]; outputs: Record<string, unknown>; schemas: Record<string, ISchema> }> {
    const { loadedResources, loadedModules } = await this.loadContext(configContent, state);

    const graph = this.dependencyGraphBuilder.buildExecutionGraph(loadedResources, loadedModules);
    const { resources: desiredResources, outputs } = this.resolveInDependencyOrder(loadedResources, graph, state);

    return { desiredResources, outputs, schemas: await this.checkWithProviders(desiredResources) };
  }

  /** What a provider can refuse before anything runs is refused here. A value not known yet is checked once the run knows it. */
  private async checkWithProviders(desired: DesiredResource[]): Promise<Record<string, ISchema>> {
    const schemas: Record<string, ISchema> = {};

    for (const resource of desired) {
      const type = resource.block.resourceType;
      const provider = this.providers.get(type);
      if (!provider) throw new Error(`No provider handles "${type}"`);

      schemas[type] ??= await provider.getSchema(type);
      if (Object.values(resource.attributes).some((value) => isUnknown(value))) continue;

      try {
        await provider.validate(type, resource.attributes);
      } catch (error) {
        throw new Error(`${Address.of(resource.block).toString()}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return schemas;
  }

  /** Runs a plan, reporting each step; the state file is rewritten after every action, so a failed run loses nothing done before it. */
  async *runPlan(saved: Plan, configContent: string): AsyncGenerator<RunEvent> {
    yield* this.locked(this.applySaved(saved, configContent));
  }

  private async *locked(run: AsyncGenerator<RunEvent>): AsyncGenerator<RunEvent> {
    await this.stateManager.lock();

    // Released on the way out however the run ends: done, failed, thrown, or dropped by the caller.
    try {
      yield* run;
    } finally {
      await this.stateManager.unlock();
    }
  }

  /** The plan is what the caller saw and approved; a state written since would make it a different plan. */
  private async *applySaved(saved: Plan, configContent: string): AsyncGenerator<RunEvent> {
    const state = await this.stateManager.read();
    if (state.serial !== saved.serial) throw new Error('The state has changed since the plan was made. Plan again.');

    yield* this.applyActions(saved.actions, configContent, state);
  }

  private async *applyActions(actions: PlanAction[], configContent: string, state: IState): AsyncGenerator<RunEvent> {
    const { mainProgram, loadedModules, loadedResources } = await this.loadContext(configContent, state);
    const graph = this.dependencyGraphBuilder.buildExecutionGraph(loadedResources, loadedModules);
    this.checkActionsMatch(actions, graph);

    yield { type: 'planned', actions };

    // Outputs belong to a finished run; every write before the last leaves them out.
    delete state.outputs;
    if (!(yield* this.applyInOrder(actions, graph, loadedModules, state))) return;
    if (!(yield* this.applyDeletes(actions, state))) return;

    // Outputs are read after the last action, so they never name a half-applied resource.
    state.outputs = this.processOutputs(mainProgram, state, Address.root('', ''));
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
  private async *applyInOrder(actions: PlanAction[], graph: Graph<GraphNode>, loadedModules: LoadedModule[], state: IState): AsyncGenerator<RunEvent, boolean> {
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
  private async *applyDeletes(actions: PlanAction[], state: IState): AsyncGenerator<RunEvent, boolean> {
    const deletes = new Map(actions.filter((action) => action.type === 'DELETE').map((action) => [Address.of(action).toString(), action]));
    const graph = this.deleteGraph(deletes, state);

    for (const layer of graph.topologicalSort().reverse()) for (const key of layer) if (!(yield* this.step(graph.getNode(key)!, state))) return false;

    return true;
  }

  private deleteGraph(deletes: Map<string, PlanAction>, state: IState): Graph<PlanAction> {
    const graph = new Graph<PlanAction>();

    for (const [key, action] of deletes) graph.addNode(key, action);

    for (const key of deletes.keys()) for (const dependency of state.resources[key]?.dependencies ?? []) if (deletes.has(dependency)) graph.addEdge(dependency, key);

    return graph;
  }

  private async *step(action: PlanAction, state: IState): AsyncGenerator<RunEvent, boolean> {
    // An unchanged resource has nothing to report; it only refreshes what it reads from, and the write that ends the run saves that.
    const quiet = action.type === 'NO_OP';
    if (!quiet) yield { type: 'started', action };

    try {
      await this.actionExecutor.execute(action, state);
    } catch (error) {
      // A replacement may have deleted before it failed to create; what happened is saved either way.
      await this.stateManager.write(state).catch(() => undefined);
      yield { type: 'failed', action, error: error instanceof Error ? error : new Error(String(error)) };
      return false;
    }

    if (quiet) return true;

    await this.stateManager.write(state);
    yield { type: 'applied', action };
    return true;
  }

  private processOutputs(program: Statement[], state: IState, context: Address): Record<string, unknown> {
    const outputs: Record<string, unknown> = {};
    const scope = this.scopeManager.getScope(context);

    for (const stmt of program)
      if (stmt.type === 'Output') {
        const resolved = this.resolveValue(stmt.value, state, context);
        outputs[stmt.name] = resolved;
        this.scopeManager.setOutput(scope, stmt.name, resolved);
      }

    return outputs;
  }

  /** Resolves each resource after the ones it reads from, so a value an earlier action will change is UNKNOWN, not stale. */
  private resolveInDependencyOrder(loadedResources: LoadedResource[], graph: Graph<GraphNode>, state: IState): { resources: DesiredResource[]; outputs: Record<string, unknown> } {
    const byKey = new Map(loadedResources.map((r) => [r.address.toString(), r]));
    const pending = new Set<string>();
    const resources: DesiredResource[] = [];
    const outputs: Record<string, unknown> = {};

    for (const layer of graph.topologicalSort())
      for (const key of layer) {
        const node = graph.getNode(key)!;

        if (node.kind === 'variable') this.planVariable(key, node, state, pending);
        else if (node.kind === 'output') this.planOutput(key, node, state, pending, outputs);
        else resources.push(this.planResource(key, byKey.get(key)!, graph, state, pending));
      }

    return { resources, outputs };
  }

  private planResource(key: string, loaded: LoadedResource, graph: Graph<GraphNode>, state: IState, pending: Set<string>): DesiredResource {
    const attributes = this.resolveForPlan(loaded.block.attributes, state, loaded.address, pending);
    const current = state.resources[key];
    if (!current || hasChanges(current.attributes, attributes)) pending.add(key);

    return { block: { ...loaded.block, modulePath: loaded.address.modulePath }, attributes, dependencies: this.dependencyGraphBuilder.resourceDependencies(graph, key) };
  }

  /** A variable fed by a pending resource is pending itself, so everything reading it plans against UNKNOWN. */
  private planVariable(key: string, node: ValueNode, state: IState, pending: Set<string>): void {
    if (node.value !== undefined && isUnknown(this.resolveOrUnknown(node.value, state, node.context, pending))) pending.add(key);
  }

  /** Gives an output its value so the resources reading it can be planned; an output fed by a pending resource keeps none. */
  private planOutput(key: string, node: ValueNode, state: IState, pending: Set<string>, rootOutputs: Record<string, unknown>): void {
    const value = this.resolveOrUnknown(node.value, state, node.context, pending);
    if (isUnknown(value)) pending.add(key);
    else this.scopeManager.setOutput(node.scope, node.name, value);

    if (node.context.modulePath.length === 0) rootOutputs[node.name] = value;
  }

  /** Resolves config values the way the diff needs them; what an apply has to produce first stays UNKNOWN. */
  private resolveForPlan(attributes: Record<string, AttributeValue>, state: IState, context: Address, pending: Set<string>): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(attributes)) resolved[key] = this.resolveOrUnknown(value, state, context, pending);

    return resolved;
  }

  private resolveOrUnknown(value: unknown, state: IState, context: Address, pending: Set<string>): unknown {
    if (this.referenceScanner.referencesIn(value, context).some((reference) => pending.has(reference.key))) return UNKNOWN;

    try {
      return this.resolveValue(value, state, context);
    } catch (error) {
      if (!(error instanceof UnresolvedReferenceError)) throw error;
      return UNKNOWN;
    }
  }

  private resolveValue(value: unknown, state: IState, context?: Address): unknown {
    return this.referenceResolver.resolveValue(value, state, context);
  }

  private convertAttributes(attributes: Record<string, unknown>, state: IState, context?: Address): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(attributes)) result[key] = this.resolveValue(value, state, context);
    return result;
  }

  private resolveOutputsOf(scope: string, loadedModules: LoadedModule[], currentState: IState): void {
    const mod = loadedModules.find((m) => this.scopeManager.getScope(m.address) === scope);
    if (mod) this.processOutputs(mod.program, currentState, mod.address);
  }

  private getAttributesMap(attributes: Record<string, AttributeValue> | undefined): Record<string, unknown> {
    const attributesMap: Record<string, unknown> = {};
    if (attributes) Object.assign(attributesMap, attributes);
    return attributesMap;
  }

  private initializeChildVariables(childAddress: Address, attributesMap: Record<string, unknown>, parentAddress: Address): void {
    const childScope = this.scopeManager.getScope(childAddress);

    for (const [key, attr] of Object.entries(attributesMap))
      if (key !== 'source')
        this.scopeManager.setVariable(childScope, key, {
          value: attr,
          context: parentAddress,
        });
  }
}
