import { IProvider, ISchema } from '@clay/contracts';
import { Graph } from '@clay/graph';
import { AttributeValue, Lexer, Parser, Statement } from '@clay/parser';
import { DesiredResource, hasChanges, isUnknown, plan, PlanAction, UNKNOWN } from '@clay/planner';
import { IState, StateManager } from '@clay/state';

import { Address } from './Address';
import { ActionExecutor } from './components/ActionExecutor';
import { DependencyGraphBuilder, GraphNode, ValueNode } from './components/DependencyGraphBuilder';
import { LoadedModule, LoadedResource, ModuleLoader } from './components/ModuleLoader';
import { ReferenceResolver } from './resolvers/ReferenceResolver';
import { RunEvent } from './RunEvent';
import { ReferenceScanner } from './resolvers/ReferenceScanner';
import { UnresolvedReferenceError } from './resolvers/UnresolvedReferenceError';
import { ScopeManager } from './scope/ScopeManager';

export type { RunEvent } from './RunEvent';

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

  constructor(stateManager: StateManager) {
    this.stateManager = stateManager;
    this.scopeManager = new ScopeManager();
    this.referenceResolver = new ReferenceResolver(this.scopeManager, this.dataSources);
    this.moduleLoader = new ModuleLoader(this.processVariables.bind(this), this.initializeChildVariables.bind(this), this.getAttributesMap.bind(this));
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

  async getSchema(resourceType: string): Promise<ISchema | undefined> {
    const provider = this.providers.get(resourceType);
    if (!provider) return undefined;

    return provider.getSchema(resourceType);
  }

  /**
   * Process variable declarations for a specific scope
   */
  private processVariables(program: Statement[], address: Address): void {
    const scope = this.scopeManager.getScope(address);

    // A module input set before this wins; a variable with no default stays undefined.
    for (const stmt of program)
      if (stmt.type === 'Variable' && !this.scopeManager.getVariable(scope, stmt.name))
        this.scopeManager.setVariable(scope, stmt.name, { value: stmt.attributes.default, context: address });
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
    rootDir: string,
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

    const { resources: loadedResources, modules: loadedModules } = await this.moduleLoader.loadModuleTree(rootDir, mainProgram);

    this.dataSources.clear();
    for (const mod of loadedModules) await this.processDataSources(mod.program, state, mod.address);

    return { mainProgram, loadedResources, loadedModules };
  }

  /**
   * Generate an execution plan without applying it
   */
  async plan(configContent: string, rootDir: string = process.cwd()): Promise<PlanAction[]> {
    const currentState = await this.stateManager.read();
    const { loadedResources, loadedModules } = await this.loadContext(configContent, rootDir, currentState);

    const graph = this.dependencyGraphBuilder.buildExecutionGraph(loadedResources, loadedModules);
    const desiredResources = this.resolveInDependencyOrder(loadedResources, graph, currentState);

    const schemas: Record<string, ISchema> = {};
    for (const r of loadedResources)
      if (!schemas[r.block.resourceType]) {
        const schema = await this.getSchema(r.block.resourceType);
        if (schema) schemas[r.block.resourceType] = schema;
      }

    return plan(desiredResources, currentState, schemas);
  }

  /** Plans and runs it, reporting each step; the state file is rewritten after every action, so a failed run loses nothing done before it. */
  async *run(configContent: string, rootDir: string = process.cwd()): AsyncGenerator<RunEvent> {
    yield* this.locked(this.planAndApply(configContent, rootDir));
  }

  /** Runs actions planned earlier, against the configuration they were planned from. */
  async *runPlan(actions: PlanAction[], configContent: string, rootDir: string = process.cwd()): AsyncGenerator<RunEvent> {
    yield* this.locked(this.applyActions(actions, configContent, rootDir));
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

  private async *planAndApply(configContent: string, rootDir: string): AsyncGenerator<RunEvent> {
    yield* this.applyActions(await this.plan(configContent, rootDir), configContent, rootDir);
  }

  private async *applyActions(actions: PlanAction[], configContent: string, rootDir: string): AsyncGenerator<RunEvent> {
    const state = await this.stateManager.read();
    const { mainProgram, loadedModules, loadedResources } = await this.loadContext(configContent, rootDir, state);
    const graph = this.dependencyGraphBuilder.buildExecutionGraph(loadedResources, loadedModules);
    this.checkActionsMatch(actions, graph);

    yield { type: 'planned', actions };

    if (!(yield* this.applyInOrder(actions, graph, loadedModules, state))) return;
    if (!(yield* this.applyDeletes(actions, state))) return;

    // Outputs are read after the last action, so they never name a half-applied resource.
    state.outputs = this.processOutputs(mainProgram, state, Address.root('', ''));
    await this.persist(state);
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
      await this.persist(state).catch(() => undefined);
      yield { type: 'failed', action, error: error instanceof Error ? error : new Error(String(error)) };
      return false;
    }

    if (quiet) return true;

    await this.persist(state);
    yield { type: 'applied', action };
    return true;
  }

  /** Named field by field, so a key an older version wrote is dropped. A field added to the state belongs here too. */
  private async persist(state: IState): Promise<void> {
    await this.stateManager.write({ version: state.version, outputs: state.outputs, resources: state.resources });
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
  private resolveInDependencyOrder(loadedResources: LoadedResource[], graph: Graph<GraphNode>, state: IState): DesiredResource[] {
    const byKey = new Map(loadedResources.map((r) => [r.address.toString(), r]));
    const pending = new Set<string>();
    const desired: DesiredResource[] = [];

    for (const layer of graph.topologicalSort())
      for (const key of layer) {
        const node = graph.getNode(key)!;

        if (node.kind === 'variable') this.planVariable(key, node, state, pending);
        else if (node.kind === 'output') this.planOutput(key, node, state, pending);
        else desired.push(this.planResource(key, byKey.get(key)!, graph, state, pending));
      }

    return desired;
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
  private planOutput(key: string, node: ValueNode, state: IState, pending: Set<string>): void {
    const value = this.resolveOrUnknown(node.value, state, node.context, pending);
    if (isUnknown(value)) pending.add(key);
    else this.scopeManager.setOutput(node.scope, node.name, value);
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
