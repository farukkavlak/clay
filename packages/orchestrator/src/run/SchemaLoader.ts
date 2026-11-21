import { Schema } from '@clay/provider';
import { ModuleAddress } from '@clay/core';
import { ConfigError, DataBlock, ResourceBlock, spell, Statement } from '@clay/parser';

import { checkNames, checkProvisionerNames } from '../checks/checkNames';
import { Context } from '../keys';
import { ProviderRegistry } from '../providers/ProviderRegistry';
import { ProvisionerRegistry } from '../providers/ProvisionerRegistry';
import { Limit, taken } from '../providers/Limit';
import { withPlace } from '../place';
import { LoadedModule, LoadedResource } from '../config/ModuleLoader';
import { Schemas, SchemaTable } from '../providers/Schemas';

/** The first item of each key, in the order they come. */
function firstOfEach<T>(items: T[], keyOf: (item: T) => string): T[] {
  const firsts = new Map<string, T>();
  for (const item of items) if (!firsts.has(keyOf(item))) firsts.set(keyOf(item), item);

  return [...firsts.values()];
}

/** Asks each provider and provisioner for the schemas a run's blocks need, and checks each block's names against its schema. */
export class SchemaLoader {
  constructor(
    private schemas: Schemas,
    private providers: ProviderRegistry,
    private provisioners: ProvisionerRegistry,
    private limit: Limit
  ) {}

  /** Loaded before any value is resolved, since resolving needs the schema's types. */
  async forBlocks(loadedResources: LoadedResource[], loadedModules: LoadedModule[]): Promise<void> {
    await this.loadChecked(
      loadedResources,
      ({ resourceType }) => resourceType,
      this.schemas.resources,
      (type) => this.providers.schema(type)
    );
    await this.loadProvisionerSchemas(loadedResources);

    const data = loadedModules.flatMap(({ address, program }) => program.flatMap((block) => (block.type === 'Data' ? [{ block, address }] : [])));
    await this.loadChecked(
      data,
      ({ dataSourceType }) => dataSourceType,
      this.schemas.dataSources,
      (type) => this.providers.dataSourceSchema(type)
    );
  }

  /** Only the root module has provider blocks. A name no provider has is refused at the block. */
  async forProviderBlocks(program: Statement[]): Promise<void> {
    const blocks = program.filter((stmt) => stmt.type === 'Provider');
    const schemas = await Promise.allSettled(blocks.map((block) => this.asked(block, ModuleAddress.root, () => this.providers.configSchema(block.name))));

    for (const [index, block] of blocks.entries()) {
      const schema = taken(schemas[index]);
      this.schemas.configs.set(block.name, schema);
      checkNames(block, schema, ModuleAddress.root);
    }
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

  /** Each type asked once, and each block's names checked, so a misspelled name is refused before anything is read. A failure names the first block of its type. */
  private async loadChecked<B extends ResourceBlock | DataBlock>(
    blocks: { block: B; address: Context }[],
    typeOf: (block: B) => string,
    table: SchemaTable,
    ask: (type: string) => Promise<Schema>
  ): Promise<void> {
    const firsts = firstOfEach(blocks, ({ block }) => typeOf(block)).filter(({ block }) => !table.has(typeOf(block)));
    const schemas = await Promise.allSettled(firsts.map(({ block, address }) => this.asked(block, address, () => ask(typeOf(block)))));
    const loaded = new Map(firsts.map(({ block }, index) => [typeOf(block), schemas[index]]));

    // In the order written, so a block's misspelled name comes before a later type that fails to load.
    for (const { block, address } of blocks) {
      const type = typeOf(block);
      const asked = loaded.get(type);
      if (asked !== undefined && !table.has(type)) table.set(type, taken(asked));
      checkNames(block, table.get(type), address);
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
}
