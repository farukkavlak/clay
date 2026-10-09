import { ModuleAddress, Schema } from '@clay/contracts';
import { AttributeValue, CONFIG_FILE, DataBlock, Lexer, Parser, spell, Statement } from '@clay/parser';

import { checkNames } from '../checkAttributes';
import { checkDefaults } from '../declared';
import { dataSourceKey } from '../keys';
import { Value } from '../Value';
import { Instances } from '../Instances';
import { ModuleInstances } from '../ModuleInstances';
import { Planned } from '../Planned';
import { ProviderRegistry } from '../ProviderRegistry';
import { tryAt, withPlace } from '../place';
import { ReferenceResolver } from '../resolvers/ReferenceResolver';
import { ScopeManager } from '../scope/ScopeManager';
import { LoadedModule, LoadedResource, ModuleLoader } from './ModuleLoader';

export interface LoadedConfig {
  mainProgram: Statement[];
  loadedResources: LoadedResource[];
  loadedModules: LoadedModule[];
  schemas: Map<string, Schema>;
}

export class ConfigLoader {
  constructor(
    private moduleLoader: ModuleLoader,
    private scopeManager: ScopeManager,
    private dataSources: Map<string, Record<string, Value>>,
    // A Map, since a resource type may be named `constructor`, which a plain object already has.
    private schemas: Map<string, Schema>,
    private dataSchemas: Map<string, Schema>,
    private resolver: ReferenceResolver,
    private providers: ProviderRegistry,
    private instances: Instances,
    private modules: ModuleInstances,
    private planned: Planned
  ) {}

  async load(configContent: string): Promise<LoadedConfig> {
    const mainProgram = new Parser(new Lexer(configContent, CONFIG_FILE).tokenize()).parse();

    this.scopeManager.clear();
    const { resources: loadedResources, modules: loadedModules } = await this.moduleLoader.loadModuleTree(mainProgram);
    this.checkDefaults(loadedModules);

    this.instances.clear();
    // Planned values belong to one plan; the next plan makes its own, and an apply reads state.
    this.planned.clear();
    for (const { uniqueId, block } of loadedResources) {
      if (block.count) this.instances.declare(uniqueId, 'count');
      if (block.forEach) this.instances.declare(uniqueId, 'for_each');
    }

    this.declareData(loadedModules);
    this.declareCalls(loadedModules);
    await this.loadSchemas(loadedResources);
    await this.loadDataSchemas(loadedModules);

    // Each data source is read, or left for the apply, in its turn in the graph.
    this.dataSources.clear();

    return { mainProgram, loadedResources, loadedModules, schemas: this.schemas };
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

  /** Loaded before any value is resolved, since resolving needs the schema's types. */
  private async loadSchemas(loaded: LoadedResource[]): Promise<void> {
    this.schemas.clear();

    for (const { block, address } of loaded) {
      const type = block.resourceType;
      if (this.schemas.has(type)) continue;

      try {
        this.schemas.set(type, await this.providers.schema(type));
      } catch (error) {
        throw withPlace(error, block.position, spell(block), address);
      }
    }
  }

  /** With its names checked, so a misspelled input is refused before anything is read. */
  private async loadDataSchemas(loadedModules: LoadedModule[]): Promise<void> {
    this.dataSchemas.clear();

    for (const { address, program } of loadedModules)
      for (const stmt of program) {
        if (stmt.type !== 'Data') continue;

        const schema = this.dataSchemas.get(stmt.dataSourceType) ?? (await this.dataSchemaOf(stmt, address));
        this.dataSchemas.set(stmt.dataSourceType, schema);
        checkNames(stmt, schema, address);
      }
  }

  private async dataSchemaOf(stmt: DataBlock, address: ModuleAddress): Promise<Schema> {
    try {
      return await this.providers.dataSourceSchema(stmt.dataSourceType);
    } catch (error) {
      throw withPlace(error, stmt.position, spell(stmt), address);
    }
  }

  /** Apart from a resource's, since a data source and a resource may share a type and a name. */
  private declareData(loadedModules: LoadedModule[]): void {
    for (const { address, program } of loadedModules)
      for (const stmt of program) if (stmt.type === 'Data' && stmt.count) this.instances.declare(dataSourceKey(address.toString(), stmt.dataSourceType, stmt.name), 'count');
  }

  private declareCalls(loadedModules: LoadedModule[]): void {
    this.modules.clear();

    for (const { address, program } of loadedModules)
      for (const stmt of program) {
        if (stmt.type === 'Module' && stmt.count) this.modules.declare(address.child(stmt.name), 'count');
        if (stmt.type === 'Module' && stmt.forEach) this.modules.declare(address.child(stmt.name), 'for_each');
      }
  }
}
