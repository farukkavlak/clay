import { ModuleAddress, Provider, Schema, State } from '@clay/contracts';
import { CONFIG_FILE, ConfigError, DataBlock, Lexer, Parser, spell, Statement } from '@clay/parser';

import { checkNames } from '../checkAttributes';
import { conformValues, writtenAt } from '../conformValues';
import { checkDataSourceRead, heldBy } from '../providerResult';
import { plainOf, Value, valueOf } from '../Value';
import { Instances } from '../Instances';
import { ModuleInstances } from '../ModuleInstances';
import { Planned } from '../Planned';
import { ProviderRegistry } from '../ProviderRegistry';
import { dataSourceKey, scopeOf } from '../keys';
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

interface Reader {
  provider: Provider;
  schema: Schema;
}

export class ConfigLoader {
  constructor(
    private moduleLoader: ModuleLoader,
    private scopeManager: ScopeManager,
    private dataSources: Map<string, Record<string, Value>>,
    // A Map, since a resource type may be named `constructor`, which a plain object already has.
    private schemas: Map<string, Schema>,
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
    // Planned values belong to one plan; the next plan makes its own, and an apply reads state.
    this.planned.clear();
    for (const { uniqueId, block } of loadedResources) {
      if (block.count) this.instances.declare(uniqueId, 'count');
      if (block.forEach) this.instances.declare(uniqueId, 'for_each');
    }

    this.declareCalls(loadedModules);
    await this.loadSchemas(loadedResources);

    this.dataSources.clear();
    for (const mod of loadedModules) await this.readDataSources(mod.program, state, mod.address);

    return { mainProgram, loadedResources, loadedModules, schemas: this.schemas };
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
        const reader = await this.readerOf(stmt, scopeAddress);
        checkNames(stmt, reader.schema, scopeAddress);
        const inputs = this.resolveInputs(stmt, state, scopeAddress);
        const attributes = await this.readDataSource(stmt, reader, inputs, scopeAddress);

        this.dataSources.set(dataSourceKey(scope, stmt.dataSourceType, stmt.name), attributes);
      }
  }

  private async readerOf(stmt: DataBlock, scopeAddress: ModuleAddress): Promise<Reader> {
    try {
      return { provider: this.providers.reader(stmt.dataSourceType), schema: await this.providers.dataSourceSchema(stmt.dataSourceType) };
    } catch (error) {
      throw withPlace(error, stmt.position, spell(stmt), scopeAddress);
    }
  }

  private async readDataSource(stmt: DataBlock, { provider, schema }: Reader, inputs: Record<string, Value>, scopeAddress: ModuleAddress): Promise<Record<string, Value>> {
    try {
      const conformed = conformValues(stmt.dataSourceType, schema, inputs);
      await provider.validateDataSource(stmt.dataSourceType, conformed);
      const read = await provider.readDataSource(stmt.dataSourceType, conformed);
      const held = heldBy(stmt.dataSourceType, 'read', schema, read);
      checkDataSourceRead(stmt.dataSourceType, schema, plainOf(held));

      // A schema attribute the read omits is null.
      const leftOut = Object.entries(schema).map(([name, { type }]) => [name, valueOf(type, null)]);
      return { ...Object.fromEntries(leftOut), ...held };
    } catch (error) {
      throw withPlace(error, writtenAt(error, stmt), spell(stmt), scopeAddress);
    }
  }

  /** A data source is read once at load, before modules have instances, so a repeated module cannot have one yet. */
  private checkReadOnce(stmt: DataBlock, module: ModuleAddress): void {
    const repeated = module.path.some((_, depth) => this.modules.repetitionOf(new ModuleAddress(module.path.slice(0, depth + 1))) !== undefined);
    if (!repeated) return;

    const place = { block: spell(stmt), module: scopeOf(module) };
    throw new ConfigError(`${spell(stmt)} is in a module called with count or for_each, where a data source cannot be read yet`, stmt.position, place);
  }

  /** One value at a time, so an error points at the value, not the block. */
  private resolveInputs(stmt: DataBlock, state: State, scopeAddress: ModuleAddress): Record<string, Value> {
    const declaration = spell(stmt);
    const inputs: Record<string, Value> = {};

    for (const [key, value] of Object.entries(stmt.attributes))
      inputs[key] = tryAt(value.position, declaration, scopeAddress, () => this.resolver.resolveValue(value, state, scopeAddress));

    return inputs;
  }
}
