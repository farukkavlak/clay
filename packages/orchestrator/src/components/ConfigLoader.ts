import { Address, State } from '@clay/contracts';
import { CONFIG_FILE, DataBlock, Lexer, Parser, spell, Statement } from '@clay/parser';

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
    private providers: ProviderRegistry
  ) {}

  async load(configContent: string, state: State): Promise<LoadedConfig> {
    const mainProgram = new Parser(new Lexer(configContent, CONFIG_FILE).tokenize()).parse();

    this.scopeManager.clear();
    const { resources: loadedResources, modules: loadedModules } = await this.moduleLoader.loadModuleTree(mainProgram);

    this.dataSources.clear();
    for (const mod of loadedModules) await this.readDataSources(mod.program, state, mod.address);

    return { mainProgram, loadedResources, loadedModules };
  }

  private async readDataSources(program: Statement[], state: State, scopeAddress: Address): Promise<void> {
    const scope = scopeOf(scopeAddress);

    for (const stmt of program)
      if (stmt.type === 'Data') {
        const provider = this.providers.get(stmt.dataSourceType);
        const inputs = this.resolveInputs(stmt, state, scopeAddress);

        await provider.validate(stmt.dataSourceType, inputs);
        const attributes = await provider.read(stmt.dataSourceType, inputs);

        this.dataSources.set(dataSourceKey(scope, stmt.dataSourceType, stmt.name), attributes);
      }
  }

  /** One value at a time, so an error points at the value that caused it and not at the block around it. */
  private resolveInputs(stmt: DataBlock, state: State, scopeAddress: Address): Record<string, unknown> {
    const declaration = spell(stmt);
    const inputs: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(stmt.attributes))
      inputs[key] = tryAt(value.position, declaration, scopeAddress, () => this.resolver.resolveValue(value, state, scopeAddress));

    return inputs;
  }
}
