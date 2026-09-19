import { IProvider, ISchema } from '@miniform/contracts';
import { AttributeValue, Lexer, Parser, Statement } from '@miniform/parser';
import { DesiredResource, plan, PlanAction, UNKNOWN } from '@miniform/planner';
import { IState, StateManager } from '@miniform/state';

import { Address } from './Address';
import { ActionExecutor } from './components/ActionExecutor';
import { DependencyGraphBuilder } from './components/DependencyGraphBuilder';
import { LoadedModule, ModuleLoader } from './components/ModuleLoader';
import { ReferenceResolver } from './resolvers/ReferenceResolver';
import { UnresolvedReferenceError } from './resolvers/UnresolvedReferenceError';
import { ScopeManager } from './scope/ScopeManager';

export class Orchestrator {
  private providers: Map<string, IProvider> = new Map();
  private dataSources: Map<string, Record<string, unknown>> = new Map();
  private stateManager: StateManager;
  private scopeManager: ScopeManager;
  private referenceResolver: ReferenceResolver;
  private moduleLoader: ModuleLoader;
  private actionExecutor: ActionExecutor;
  private dependencyGraphBuilder: DependencyGraphBuilder;

  constructor(stateManager: StateManager) {
    this.stateManager = stateManager;
    this.scopeManager = new ScopeManager();
    this.referenceResolver = new ReferenceResolver(this.scopeManager, this.dataSources);
    this.moduleLoader = new ModuleLoader(this.processVariables.bind(this), this.initializeChildVariables.bind(this), this.getAttributesMap.bind(this));
    this.dependencyGraphBuilder = new DependencyGraphBuilder(this.scopeManager);
    this.actionExecutor = new ActionExecutor(this.providers, this.convertAttributes.bind(this), this.resolveOutputByKey.bind(this));
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

    for (const stmt of program)
      if (stmt.type === 'Variable') {
        const defaultValue = stmt.attributes.default?.value;
        // Set variable even if no default (will be undefined until set by module inputs)
        if (!this.scopeManager.getVariable(scope, stmt.name)) this.scopeManager.setVariable(scope, stmt.name, { value: defaultValue, context: address });
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
    const { loadedResources } = await this.loadContext(configContent, rootDir, currentState);

    const desiredResources: DesiredResource[] = loadedResources.map((r) => ({
      block: { ...r.block, modulePath: r.address.modulePath },
      attributes: this.resolveForPlan(r.block.attributes, currentState, r.address),
    }));

    const schemas: Record<string, ISchema> = {};
    for (const r of loadedResources)
      if (!schemas[r.block.resourceType]) {
        const schema = await this.getSchema(r.block.resourceType);
        if (schema) schemas[r.block.resourceType] = schema;
      }

    return plan(desiredResources, currentState, schemas);
  }

  async apply(configContent: string, rootDir: string = process.cwd()): Promise<Record<string, unknown>> {
    // 1. Initial Plan (Dry Run to get actions)
    // Note: We might be engaging in double work here (re-parsing), but plan() is stateless.
    // Optimization: plan could return context, but for now we keep API simple.
    const allActions = await this.plan(configContent, rootDir);

    const currentState = await this.stateManager.read();

    // 2. Load execution context (Modules, DataSources, etc.)
    const { mainProgram, loadedModules, loadedResources } = await this.loadContext(configContent, rootDir, currentState);

    // 3. Build Dependency Graph
    const graph = this.dependencyGraphBuilder.buildExecutionGraph(loadedResources, loadedModules);

    // 4. Execution
    const createUpdateActions = allActions.filter((a) => a.type !== 'DELETE');
    await this.actionExecutor.executeActionsSequentially(createUpdateActions, graph, currentState, loadedModules);

    const deleteActions = allActions.filter((a) => a.type === 'DELETE');
    for (const action of deleteActions) {
      const provider = this.providers.get(action.resourceType);
      if (!provider) throw new Error(`No provider registered for resource type "${action.resourceType}"`);
      await this.actionExecutor.executeDelete(action, provider, currentState);
    }

    // 5. Sync & Persist
    this.syncStateVariables(currentState);
    await this.stateManager.write(currentState);

    return this.processOutputs(mainProgram, currentState, Address.root('', ''));
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

  /** Resolves config values the way the diff needs them; what an apply has to produce first stays UNKNOWN. */
  private resolveForPlan(attributes: Record<string, AttributeValue>, state: IState, context: Address): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(attributes))
      try {
        resolved[key] = this.resolveValue(value, state, context);
      } catch (error) {
        if (!(error instanceof UnresolvedReferenceError)) throw error;
        resolved[key] = UNKNOWN;
      }

    return resolved;
  }

  private resolveValue(value: unknown, state: IState, context?: Address): unknown {
    return this.referenceResolver.resolveValue(value, state, context);
  }

  private convertAttributes(attributes: Record<string, unknown>, state: IState, context?: Address): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(attributes)) result[key] = this.resolveValue(value, state, context);
    return result;
  }

  private resolveOutputByKey(key: string, loadedModules: LoadedModule[], currentState: IState): void {
    const parts = key.split('.outputs.');
    const scope = parts[0];
    const mod = loadedModules.find((m) => this.scopeManager.getScope(m.address) === scope);
    if (mod) this.processOutputs(mod.program, currentState, mod.address);
  }

  private syncStateVariables(currentState: IState): void {
    const varsObj: Record<string, Record<string, unknown>> = {};
    for (const [scope, varMap] of this.scopeManager.getAllVariables().entries()) {
      const simpleVarMap: Record<string, unknown> = {};
      for (const [k, v] of varMap.entries()) simpleVarMap[k] = v.value;
      varsObj[scope] = simpleVarMap;
    }
    currentState.variables = varsObj;
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
