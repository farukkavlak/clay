import { Address, IState } from '@clay/contracts';
import { Lexer, Parser, Statement } from '@clay/parser';

import { ProviderRegistry } from '../ProviderRegistry';
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

  async load(configContent: string, state: IState): Promise<LoadedConfig> {
    const mainProgram = new Parser(new Lexer(configContent).tokenize()).parse();

    this.scopeManager.clear();
    const { resources: loadedResources, modules: loadedModules } = await this.moduleLoader.loadModuleTree(mainProgram);

    this.dataSources.clear();
    for (const mod of loadedModules) await this.readDataSources(mod.program, state, mod.address);

    return { mainProgram, loadedResources, loadedModules };
  }

  private async readDataSources(program: Statement[], state: IState, scopeAddress: Address): Promise<void> {
    const scope = this.scopeManager.getScope(scopeAddress);

    for (const stmt of program)
      if (stmt.type === 'Data') {
        const provider = this.providers.get(stmt.dataSourceType);
        const inputs = this.resolver.resolveAttributes(stmt.attributes, state, scopeAddress);

        await provider.validate(stmt.dataSourceType, inputs);
        const attributes = await provider.read(stmt.dataSourceType, inputs);

        const key = scope ? `${scope}.${stmt.dataSourceType}.${stmt.name}` : `${stmt.dataSourceType}.${stmt.name}`;
        this.dataSources.set(key, attributes);
      }
  }
}
