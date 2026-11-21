import { Schema } from '@clay/provider';
import { ModuleAddress } from '@clay/core';
import { AttributeValue, ConfigError, DataBlock, ResourceBlock, spell, Statement } from '@clay/parser';

import { checkNames, checkProvisionerNames } from '../checks/checkAttributes';
import { checkDefaults } from '../values/declared';
import { Context, dataSourceKey } from '../keys';
import { Instances } from '../instances/Instances';
import { ModuleInstances } from '../instances/ModuleInstances';
import { ProviderRegistry } from '../providers/ProviderRegistry';
import { ProvisionerRegistry } from '../providers/ProvisionerRegistry';
import { Limit, taken } from '../providers/Limit';
import { tryAt, withPlace } from '../place';
import { ReferenceResolver } from '../expressions/ReferenceResolver';
import { LoadedModule, LoadedResource, ModuleLoader, Part, RootValues } from '../config/ModuleLoader';
import { checkProviderChoices } from '../config/providerChoices';
import { Schemas, SchemaTable } from '../providers/Schemas';

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
  resourceSchemas: SchemaTable;
}

export class ConfigLoader {
  constructor(
    private moduleLoader: ModuleLoader,
    private schemas: Schemas,
    private resolver: ReferenceResolver,
    private providers: ProviderRegistry,
    private provisioners: ProvisionerRegistry,
    private instances: Instances,
    private modules: ModuleInstances,
    private limit: Limit
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
    await this.loadSchemas(loadedResources);
    await this.loadProvisionerSchemas(loadedResources);
    await this.loadDataSchemas(loadedModules);
    checkProviderChoices(loadedModules, (block) => this.handlerOf(block));
    await this.loadConfigSchemas(mainProgram);

    return { mainProgram, loadedResources, loadedModules, resourceSchemas: this.schemas.resources };
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
    const firsts = firstOfEach(loaded, ({ block }) => block.resourceType).filter(({ block }) => !this.schemas.resources.has(block.resourceType));
    const schemas = await Promise.allSettled(firsts.map(({ block, address }) => this.asked(block, address, () => this.providers.schema(block.resourceType))));

    for (const [index, { block }] of firsts.entries()) this.schemas.resources.set(block.resourceType, taken(schemas[index]));
  }

  /** With each block's names checked; a type no provisioner has is refused at its label. */
  private async loadProvisionerSchemas(loaded: LoadedResource[]): Promise<void> {
    const blocks = loaded.flatMap(({ block, address }) => (block.provisioners ?? []).map((provisioner) => ({ provisioner, block, address })));
    for (const { provisioner, block, address } of blocks) {
      const { value, position } = provisioner.provisionerType;
      if (!this.provisioners.has(value)) throw withPlace(new ConfigError(`There is no provisioner "${value}"`, position), position, spell(block), address);
    }

    const firsts = firstOfEach(blocks, ({ provisioner }) => provisioner.provisionerType.value).filter(
      ({ provisioner }) => !this.schemas.provisioners.has(provisioner.provisionerType.value)
    );
    const schemas = await Promise.allSettled(
      firsts.map(({ block, address, provisioner }) => this.asked(block, address, () => this.provisioners.schema(provisioner.provisionerType.value)))
    );
    for (const [index, { provisioner }] of firsts.entries()) this.schemas.provisioners.set(provisioner.provisionerType.value, taken(schemas[index]));

    for (const { provisioner, block, address } of blocks) checkProvisionerNames(provisioner, this.schemas.provisioners.get(provisioner.provisionerType.value), block, address);
  }

  /** With its names checked, so a misspelled input is refused before anything is read. */
  private async loadDataSchemas(loadedModules: LoadedModule[]): Promise<void> {
    const blocks = loadedModules.flatMap(({ address, program }) => program.flatMap((stmt) => (stmt.type === 'Data' ? [{ stmt, address }] : [])));
    const firsts = firstOfEach(blocks, ({ stmt }) => stmt.dataSourceType).filter(({ stmt }) => !this.schemas.dataSources.has(stmt.dataSourceType));
    const schemas = await Promise.allSettled(firsts.map(({ stmt, address }) => this.asked(stmt, address, () => this.providers.dataSourceSchema(stmt.dataSourceType))));
    const loaded = new Map(firsts.map(({ stmt }, index) => [stmt.dataSourceType, schemas[index]]));

    // In the order written, so a block's misspelled name comes before a later type that fails to load.
    for (const { stmt, address } of blocks) {
      const type = stmt.dataSourceType;
      const asked = loaded.get(type);
      if (asked !== undefined && !this.schemas.dataSources.has(type)) this.schemas.dataSources.set(type, taken(asked));
      checkNames(stmt, this.schemas.dataSources.get(type), address);
    }
  }

  private handlerOf(block: ResourceBlock | DataBlock): string {
    return (block.type === 'Resource' ? this.providers.get(block.resourceType) : this.providers.reader(block.dataSourceType)).name;
  }

  /** Only the root module has provider blocks. A name no provider has is refused at the block. */
  private async loadConfigSchemas(program: Statement[]): Promise<void> {
    const blocks = program.filter((stmt) => stmt.type === 'Provider');
    const schemas = await Promise.allSettled(blocks.map((block) => this.asked(block, ModuleAddress.root, () => this.providers.configSchema(block.name))));

    for (const [index, block] of blocks.entries()) {
      const schema = taken(schemas[index]);
      this.schemas.configs.set(block.name, schema);
      checkNames(block, schema, ModuleAddress.root);
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
