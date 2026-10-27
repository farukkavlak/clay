import { Schema } from '@clay/contracts';
import { AttributeValue, spell, Statement } from '@clay/parser';

import { checkNames } from '../checks/checkAttributes';
import { checkDefaults } from '../values/declared';
import { Context, dataSourceKey } from '../keys';
import { Value } from '../values/Value';
import { Instances } from '../instances/Instances';
import { ModuleInstances } from '../instances/ModuleInstances';
import { Planned } from '../values/Planned';
import { ProviderRegistry } from '../providers/ProviderRegistry';
import { Limit, taken } from '../providers/Limit';
import { tryAt, withPlace } from '../place';
import { ReferenceResolver } from '../expressions/ReferenceResolver';
import { ScopeManager } from '../config/ScopeManager';
import { LoadedModule, LoadedResource, ModuleLoader } from '../config/ModuleLoader';

/** The first item of each key, in the order they come. */
function firstOfEach<T>(items: T[], keyOf: (item: T) => string): T[] {
  const firsts = new Map<string, T>();
  for (const item of items) if (!firsts.has(keyOf(item))) firsts.set(keyOf(item), item);

  return [...firsts.values()];
}

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
    private planned: Planned,
    private limit: Limit
  ) {}

  async load(): Promise<LoadedConfig> {
    const { resources: loadedResources, modules: loadedModules, root: mainProgram } = await this.moduleLoader.loadModuleTree();
    this.checkDefaults(loadedModules);

    for (const { uniqueId, block } of loadedResources) {
      if (block.count) this.instances.declare(uniqueId, 'count');
      if (block.forEach) this.instances.declare(uniqueId, 'for_each');
    }

    this.declareData(loadedModules);
    this.declareCalls(loadedModules);
    await this.loadSchemas(loadedResources);
    await this.loadDataSchemas(loadedModules);

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

  /** Loaded before any value is resolved, since resolving needs the schema's types. A failure names the first block of its type. */
  private async loadSchemas(loaded: LoadedResource[]): Promise<void> {
    const firsts = firstOfEach(loaded, ({ block }) => block.resourceType).filter(({ block }) => !this.schemas.has(block.resourceType));
    const schemas = await Promise.allSettled(firsts.map(({ block, address }) => this.asked(block, address, () => this.providers.schema(block.resourceType))));

    for (const [index, { block }] of firsts.entries()) this.schemas.set(block.resourceType, taken(schemas[index]));
  }

  /** With its names checked, so a misspelled input is refused before anything is read. */
  private async loadDataSchemas(loadedModules: LoadedModule[]): Promise<void> {
    const blocks = loadedModules.flatMap(({ address, program }) => program.flatMap((stmt) => (stmt.type === 'Data' ? [{ stmt, address }] : [])));
    const firsts = firstOfEach(blocks, ({ stmt }) => stmt.dataSourceType).filter(({ stmt }) => !this.dataSchemas.has(stmt.dataSourceType));
    const schemas = await Promise.allSettled(firsts.map(({ stmt, address }) => this.asked(stmt, address, () => this.providers.dataSourceSchema(stmt.dataSourceType))));
    const loaded = new Map(firsts.map(({ stmt }, index) => [stmt.dataSourceType, schemas[index]]));

    for (const { stmt, address } of blocks) {
      const schema = this.dataSchemas.get(stmt.dataSourceType) ?? taken(loaded.get(stmt.dataSourceType)!);
      this.dataSchemas.set(stmt.dataSourceType, schema);
      checkNames(stmt, schema, address);
    }
  }

  /** Through the limit, and placed at the block that asked. */
  private async asked(block: Statement, address: Context, ask: () => Promise<Schema>): Promise<Schema> {
    try {
      return await this.limit.run(ask);
    } catch (error) {
      throw withPlace(error, block.position, spell(block), address);
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
