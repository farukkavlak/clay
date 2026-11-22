import { AttributeValue, spell, Statement } from '@clay/parser';

import { checkDefaults } from '../values/declared';
import { dataSourceKey } from '../keys';
import { Instances } from '../instances/Instances';
import { ModuleInstances } from '../instances/ModuleInstances';
import { ProviderRegistry } from '../providers/ProviderRegistry';
import { tryAt } from '../place';
import { ReferenceResolver } from '../expressions/ReferenceResolver';
import { LoadedModule, LoadedResource, ModuleLoader, Part, RootValues } from '../config/ModuleLoader';
import { checkProviderChoices, checkProviderPasses } from '../config/providerChoices';
import { SchemaLoader } from './SchemaLoader';

export interface LoadedConfig {
  mainProgram: Statement[];
  loadedResources: LoadedResource[];
  loadedModules: LoadedModule[];
}

export class ConfigLoader {
  constructor(
    private moduleLoader: ModuleLoader,
    private schemaLoader: SchemaLoader,
    private resolver: ReferenceResolver,
    private providers: ProviderRegistry,
    private instances: Instances,
    private modules: ModuleInstances
  ) {}

  async load(values?: RootValues, part?: Part): Promise<LoadedConfig> {
    const { resources: loadedResources, modules: loadedModules, root: mainProgram } = await this.moduleLoader.loadModuleTree(values, part);
    this.checkDefaults(loadedModules);

    for (const { uniqueId, block } of loadedResources) {
      if (block.count) this.instances.declare(uniqueId, 'count');
      if (block.forEach) this.instances.declare(uniqueId, 'for_each');
    }

    this.declareData(loadedModules);
    this.declareCalls(loadedModules);
    await this.schemaLoader.forBlocks(loadedResources, loadedModules);
    checkProviderChoices(loadedModules, (block) => this.providers.handlerOf(block));
    checkProviderPasses(loadedModules, (name) => this.providers.has(name));
    await this.schemaLoader.forProviderBlocks(mainProgram);

    return { mainProgram, loadedResources, loadedModules };
  }

  /** Before anything reads a variable or an output, so a bad default is reported at the default. */
  private checkDefaults(loadedModules: LoadedModule[]): void {
    for (const { address, program } of loadedModules) {
      const read = (node: AttributeValue) => this.resolver.readAsWritten(node, address);

      for (const stmt of program) {
        if ((stmt.type !== 'Variable' && stmt.type !== 'Output') || !stmt.valueType || !stmt.defaults) continue;

        const declaration = spell(stmt);
        const holder = stmt.type === 'Output' ? 'output' : 'variable';
        checkDefaults(holder, stmt.name, stmt.valueType, { tree: stmt.defaults, read }, (node, check) => tryAt(node.position, declaration, address, check));
      }
    }
  }

  /** Apart from a resource's, since a data source and a resource may share a type and a name. */
  private declareData(loadedModules: LoadedModule[]): void {
    for (const { address, program } of loadedModules)
      for (const stmt of program) {
        if (stmt.type !== 'Data') continue;

        const key = dataSourceKey(address.toString(), stmt.dataSourceType, stmt.name);
        if (stmt.count) this.instances.declare(key, 'count');
        if (stmt.forEach) this.instances.declare(key, 'for_each');
      }
  }

  private declareCalls(loadedModules: LoadedModule[]): void {
    for (const { address, program } of loadedModules)
      for (const stmt of program) {
        if (stmt.type === 'Module' && stmt.count) this.modules.declare(address.child(stmt.name), 'count');
        if (stmt.type === 'Module' && stmt.forEach) this.modules.declare(address.child(stmt.name), 'for_each');
      }
  }
}
