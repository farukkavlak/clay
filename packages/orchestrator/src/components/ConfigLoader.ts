import { ModuleAddress, State } from '@clay/contracts';
import { CONFIG_FILE, ConfigError, DataBlock, Lexer, Parser, spell, Statement } from '@clay/parser';

import { Instances } from '../Instances';
import { ModuleInstances } from '../ModuleInstances';
import { Planned } from '../Planned';
import { ProviderRegistry } from '../ProviderRegistry';
import { dataSourceKey, scopeOf } from '../keys';
import { tryAt } from '../place';
import { ReferenceResolver } from '../resolvers/ReferenceResolver';
import { ScopeManager } from '../scope/ScopeManager';
import { LoadedModule, LoadedResource, ModuleLoader } from './ModuleLoader';

/** A configuration with its modules read, its variables declared and its data sources read. */
export interface LoadedConfig {
  mainProgram: Statement[];
  loadedResources: LoadedResource[];
  loadedModules: LoadedModule[];
}

export class ConfigLoader {
  constructor(
    private moduleLoader: ModuleLoader,
    private scopeManager: ScopeManager,
    private dataSources: Map<string, Record<string, unknown>>,
    private resolver: ReferenceResolver,
    private providers: ProviderRegistry,
    private instances: Instances,
    private modules: ModuleInstances,
    private planned: Planned
  ) {}

  async load(configContent: string, state: State): Promise<LoadedConfig> {
    const mainProgram = new Parser(new Lexer(configContent, CONFIG_FILE).tokenize()).parse();

    this.scopeManager.clear();
    const { resources: loadedResources, modules: loadedModules } = await this.moduleLoader.loadModuleTree(mainProgram);

    this.instances.clear();
    // A plan's values are its own; the next plan makes its own, and an apply reads state.
    this.planned.clear();
    for (const { uniqueId, block } of loadedResources) {
      if (block.count) this.instances.declare(uniqueId, 'count');
      if (block.forEach) this.instances.declare(uniqueId, 'for_each');
    }

    this.declareCalls(loadedModules);

    this.dataSources.clear();
    for (const mod of loadedModules) await this.readDataSources(mod.program, state, mod.address);

    return { mainProgram, loadedResources, loadedModules };
  }

  private declareCalls(loadedModules: LoadedModule[]): void {
    this.modules.clear();

    for (const { address, program } of loadedModules)
      for (const stmt of program) {
        if (stmt.type === 'Module' && stmt.count) this.modules.declare(address.child(stmt.name), 'count');
        if (stmt.type === 'Module' && stmt.forEach) this.modules.declare(address.child(stmt.name), 'for_each');
      }
  }

  private async readDataSources(program: Statement[], state: State, scopeAddress: ModuleAddress): Promise<void> {
    const scope = scopeOf(scopeAddress);

    for (const stmt of program)
      if (stmt.type === 'Data') {
        this.checkReadOnce(stmt, scopeAddress);
        const provider = this.providers.get(stmt.dataSourceType);
        const inputs = this.resolveInputs(stmt, state, scopeAddress);

        await provider.validate(stmt.dataSourceType, inputs);
        const attributes = await provider.read(stmt.dataSourceType, inputs);

        this.dataSources.set(dataSourceKey(scope, stmt.dataSourceType, stmt.name), attributes);
      }
  }

  /** A data source is read once, as the config loads and before any module has instances, so a module whose instances each want their own cannot have one yet. */
  private checkReadOnce(stmt: DataBlock, module: ModuleAddress): void {
    const repeated = module.path.some((_, depth) => this.modules.repetitionOf(new ModuleAddress(module.path.slice(0, depth + 1))) !== undefined);
    if (!repeated) return;

    const place = { block: spell(stmt), module: scopeOf(module) };
    throw new ConfigError(`${spell(stmt)} is in a module called with count or for_each, where a data source cannot be read yet`, stmt.position, place);
  }

  /** One value at a time, so an error points at the value that caused it and not at the block around it. */
  private resolveInputs(stmt: DataBlock, state: State, scopeAddress: ModuleAddress): Record<string, unknown> {
    const declaration = spell(stmt);
    const inputs: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(stmt.attributes))
      inputs[key] = tryAt(value.position, declaration, scopeAddress, () => this.resolver.resolveValue(value, state, scopeAddress));

    return inputs;
  }
}
