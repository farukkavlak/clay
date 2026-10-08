import { ModuleAddress, Output, Schema, State } from '@clay/contracts';
import { AttributeValue, CONFIG_FILE, ConfigError, DataBlock, Lexer, Parser, spell, Statement } from '@clay/parser';
import { Plan } from '@clay/planner';

import { checkNames } from '../checkAttributes';
import { checkDefaults } from '../declared';
import { Value, valueOf } from '../Value';
import { Instances } from '../Instances';
import { ModuleInstances } from '../ModuleInstances';
import { Planned } from '../Planned';
import { ProviderRegistry } from '../ProviderRegistry';
import { dataSourceKey, scopeOf } from '../keys';
import { tryAt, withPlace } from '../place';
import { ReferenceResolver } from '../resolvers/ReferenceResolver';
import { ScopeManager } from '../scope/ScopeManager';
import { DataSourceReader } from './DataSourceReader';
import { LoadedModule, LoadedResource, ModuleLoader } from './ModuleLoader';

export interface LoadedConfig {
  mainProgram: Statement[];
  loadedResources: LoadedResource[];
  loadedModules: LoadedModule[];
  schemas: Map<string, Schema>;
  dataSources: Plan['dataSources'];
}

function carried(read: Record<string, Value>): Record<string, Output> {
  return Object.fromEntries(Object.entries(read).map(([name, { type, data }]) => [name, { value: data, type }]));
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
    private reader: DataSourceReader,
    private instances: Instances,
    private modules: ModuleInstances,
    private planned: Planned
  ) {}

  /** With `planned`, the values of a plan, no data source is read again. */
  async load(configContent: string, state: State, planned?: Plan['dataSources']): Promise<LoadedConfig> {
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

    this.declareCalls(loadedModules);
    await this.loadSchemas(loadedResources);
    await this.loadDataSchemas(loadedModules);

    this.dataSources.clear();
    for (const mod of loadedModules) await this.readDataSources(mod.program, state, mod.address, planned);

    const dataSources = Object.fromEntries([...this.dataSources].map(([key, read]) => [key, carried(read)]));
    return { mainProgram, loadedResources, loadedModules, schemas: this.schemas, dataSources };
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

  private declareCalls(loadedModules: LoadedModule[]): void {
    this.modules.clear();

    for (const { address, program } of loadedModules)
      for (const stmt of program) {
        if (stmt.type === 'Module' && stmt.count) this.modules.declare(address.child(stmt.name), 'count');
        if (stmt.type === 'Module' && stmt.forEach) this.modules.declare(address.child(stmt.name), 'for_each');
      }
  }

  private async readDataSources(program: Statement[], state: State, scopeAddress: ModuleAddress, planned?: Plan['dataSources']): Promise<void> {
    const scope = scopeOf(scopeAddress);

    for (const stmt of program)
      if (stmt.type === 'Data') {
        const key = dataSourceKey(scope, stmt.dataSourceType, stmt.name);

        this.dataSources.set(key, planned ? this.plannedRead(stmt, planned, key, scopeAddress) : await this.read(stmt, state, scopeAddress));
      }
  }

  private async read(stmt: DataBlock, state: State, scopeAddress: ModuleAddress): Promise<Record<string, Value>> {
    this.checkReadOnce(stmt, scopeAddress);

    return await this.reader.read(stmt, this.resolveInputs(stmt, state, scopeAddress), scopeAddress);
  }

  /** A plan that lacks one was made from another configuration. */
  private plannedRead(stmt: DataBlock, planned: Plan['dataSources'], key: string, scopeAddress: ModuleAddress): Record<string, Value> {
    if (!Object.hasOwn(planned, key)) {
      const missing = new Error(`The plan has no value for data.${stmt.dataSourceType}.${stmt.name}, which the configuration declares`);
      throw withPlace(missing, stmt.position, spell(stmt), scopeAddress);
    }

    return Object.fromEntries(Object.entries(planned[key]).map(([name, { type, value }]) => [name, valueOf(type, value)]));
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
