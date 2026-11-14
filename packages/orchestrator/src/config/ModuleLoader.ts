import { Address, ModuleAddress, Type, types } from '@clay/contracts';
import { VariableInput } from '@clay/planner';
import { ConfigError, ModuleBlock, ModuleFile, OutputBlock, parseModule, ResourceBlock, Statement, spell, VariableBlock } from '@clay/parser';
import path from 'node:path';

import { ConfigFiles, moduleFiles } from './ConfigFiles';
import { withGiven } from './givenValues';
import { required } from '../values/declared';
import { blockKey, callKey, DataInstance, dataSourceKey, ModuleCall, scopeOf } from '../keys';
import { ScopeManager } from './ScopeManager';

function validationsOf(variable: VariableBlock) {
  return variable.validations && { validations: { rules: variable.validations, declaration: spell(variable) } };
}

/** What the root module's variables are given from outside the configuration. */
export interface RootValues {
  inputs?: readonly VariableInput[];
  /** What a root variable with no value does: a check takes it as unknown, and anything else refuses it. */
  unset?: 'refuse' | 'unknown';
}

/** A module's caller gives its variables their values; only the root's come from outside. */
function noValue(variable: VariableBlock, address: ModuleAddress): ConfigError {
  const scope = scopeOf(address);
  const hint = address.isRoot() ? `; give it one with --var ${variable.name}=<value>` : '';

  return new ConfigError(`variable "${variable.name}" has no value${hint}`, variable.position, { block: spell(variable), module: scope || undefined });
}

export interface LoadedResource {
  uniqueId: string;
  address: Address;
  block: ResourceBlock;
}

export interface LoadedModule {
  address: ModuleAddress;
  program: Statement[];
}

export interface Loaded {
  resources: LoadedResource[];
  modules: LoadedModule[];
}

/** The type each output's value has once filled, `dynamic` where it names none. */
export function outputsOf(program: Statement[]): Map<string, Type> {
  return new Map(program.flatMap((stmt) => (stmt.type === 'Output' ? [[stmt.name, stmt.valueType ? required(stmt.valueType) : types.dynamic]] : [])));
}

function outputBlocksOf(program: Statement[]): Map<string, OutputBlock> {
  return new Map(program.flatMap((stmt) => (stmt.type === 'Output' ? [[stmt.name, stmt]] : [])));
}

export class ModuleLoader {
  // One load sees one version of a directory, however many blocks call its module.
  private contents = new Map<string, ModuleFile[]>();

  constructor(
    private files: ConfigFiles,
    private scopeManager: ScopeManager
  ) {}

  /** `root` stands in for the root module's files, which are then not read. */
  async loadModuleTree(root?: Statement[], { inputs = [], unset }: RootValues = {}): Promise<Loaded & { root: Statement[] }> {
    const loaded: Loaded = { resources: [], modules: [] };
    this.contents.clear();

    const written = root ?? this.parseConfig('.');
    if (written === undefined) throw new Error('no .clay file in the directory');
    const rootProgram = withGiven(written, inputs);

    const parentAddress = ModuleAddress.root;
    loaded.modules.push({ address: parentAddress, program: rootProgram });
    this.scopeManager.setDirectory(scopeOf(parentAddress), '.');
    this.declareVariables(rootProgram, parentAddress, unset);
    this.declareLocals(rootProgram, parentAddress);
    this.declareBlocks(rootProgram, parentAddress);

    for (const stmt of rootProgram)
      if (stmt.type === 'Resource') {
        const address = Address.root(stmt.resourceType, stmt.name);
        loaded.resources.push({ uniqueId: address.toString(), address, block: stmt });
      } else if (stmt.type === 'Module') await this.loadChildModule(stmt, '.', parentAddress, loaded, ['.']);

    return { ...loaded, root: rootProgram };
  }

  private async loadChildModule(stmt: ModuleBlock, parentDir: string, parentAddress: ModuleAddress, loaded: Loaded, loadingDirs: string[]): Promise<void> {
    const moduleName = stmt.name;
    const { moduleDir, moduleProgram } = this.readModule(stmt, parentDir, parentAddress, loadingDirs);

    const childAddress = parentAddress.child(moduleName);
    this.declareInputs(stmt, moduleProgram, childAddress, parentAddress);

    loaded.modules.push({ address: childAddress, program: moduleProgram });
    this.scopeManager.setDirectory(scopeOf(childAddress), moduleDir);
    this.scopeManager.declareOutputs(scopeOf(childAddress), outputsOf(moduleProgram), outputBlocksOf(moduleProgram));
    this.declareVariables(moduleProgram, childAddress);
    this.declareLocals(moduleProgram, childAddress);
    this.declareBlocks(moduleProgram, childAddress);

    for (const childStmt of moduleProgram)
      if (childStmt.type === 'Resource') {
        const resourceAddress = new Address(childAddress, childStmt.resourceType, childStmt.name);
        loaded.resources.push({ uniqueId: resourceAddress.toString(), address: resourceAddress, block: childStmt });
      } else if (childStmt.type === 'Module') await this.loadChildModule(childStmt, moduleDir, childAddress, loaded, [...loadingDirs, moduleDir]);
  }

  private readModule(stmt: ModuleBlock, parentDir: string, parentAddress: ModuleAddress, loadingDirs: string[]): { moduleDir: string; moduleProgram: Statement[] } {
    const source = stmt.attributes.source;
    const place = { block: spell(stmt), module: scopeOf(parentAddress) || undefined };

    if (source?.type !== 'String') throw new ConfigError(`Module "${stmt.name}" is missing a valid "source" attribute.`, (source ?? stmt).position, place);

    // Registry and remote modules are not supported, and an absolute path ties the configuration to one machine.
    if (!/^\.\.?\//.test(source.value))
      throw new ConfigError(`module "${stmt.name}" has source "${source.value}", which is not a local path: a source starts with ./ or ../`, source.position, place);

    // The trailing "." normalizes the path, so a cycle is detected on the hop that closes it.
    const moduleDir = path.posix.join(parentDir, source.value, '.');
    if (loadingDirs.includes(moduleDir)) throw new ConfigError(`Module source cycle detected: ${[...loadingDirs, moduleDir].join(' -> ')}`, source.position, place);

    const moduleProgram = this.parseConfig(moduleDir);
    if (moduleProgram === undefined) throw new ConfigError(`module "${stmt.name}" has no .clay file in directory "${moduleDir}"`, source.position, place);

    const backend = moduleProgram.find((moduleStmt) => moduleStmt.type === 'Backend');
    if (backend)
      throw new ConfigError(`module "${stmt.name}" names a backend, which only the root configuration can: a module keeps its state with its caller's`, backend.position);

    return { moduleDir, moduleProgram };
  }

  private parseConfig(dir: string): Statement[] | undefined {
    if (!this.contents.has(dir)) this.contents.set(dir, moduleFiles(this.files, dir));
    const files = this.contents.get(dir) ?? [];
    if (files.length === 0) return undefined;

    return parseModule(files);
  }

  private declareInputs(stmt: ModuleBlock, program: Statement[], childAddress: ModuleAddress, parentAddress: ModuleAddress): void {
    const declared = new Map(program.filter((moduleStmt) => moduleStmt.type === 'Variable').map((variable) => [variable.name, variable]));
    const childScope = scopeOf(childAddress);
    const block = spell(stmt);

    for (const [key, value] of Object.entries(stmt.attributes)) {
      if (key === 'source') continue;
      const variable = declared.get(key);
      if (!variable) throw new ConfigError(`module "${stmt.name}" has no variable "${key}"`, value.position, { block, module: scopeOf(parentAddress) || undefined });

      this.scopeManager.setVariable(childScope, key, {
        value,
        position: value.position,
        context: new ModuleCall(childAddress),
        type: variable.valueType,
        defaults: variable.defaults,
        sensitive: variable.sensitive,
        block,
        ...validationsOf(variable),
      });
    }
  }

  private declareLocals(program: Statement[], address: ModuleAddress): void {
    for (const stmt of program) if (stmt.type === 'Local') this.scopeManager.declareLocal(scopeOf(address), stmt);
  }

  /** A block's values are read in the block, as its instances read them; a call's for_each in the module that makes it. */
  private declareBlocks(program: Statement[], address: ModuleAddress): void {
    for (const stmt of program) {
      if (stmt.type === 'Resource') {
        const context = new Address(address, stmt.resourceType, stmt.name);
        this.scopeManager.declareBlock(blockKey(context), { block: stmt, context });
      }
      if (stmt.type === 'Data')
        this.scopeManager.declareBlock(dataSourceKey(scopeOf(address), stmt.dataSourceType, stmt.name), {
          block: stmt,
          context: new DataInstance(address, stmt.dataSourceType, stmt.name),
        });
      if (stmt.type === 'Module') this.scopeManager.declareCall(callKey(address.child(stmt.name)), { block: stmt, context: address });
    }
  }

  private declareVariables(program: Statement[], address: ModuleAddress, unset: RootValues['unset'] = 'refuse'): void {
    const scope = scopeOf(address);

    // A variable with an input or a default is not missing.
    for (const stmt of program) {
      if (stmt.type !== 'Variable' || this.scopeManager.getVariable(scope, stmt.name)) continue;
      const value = stmt.attributes.default;
      if (value === undefined && unset === 'refuse') throw noValue(stmt, address);

      this.scopeManager.setVariable(scope, stmt.name, {
        value,
        position: value?.position ?? stmt.position,
        context: address,
        type: stmt.valueType,
        defaults: stmt.defaults,
        sensitive: stmt.sensitive,
        block: spell(stmt),
        ...validationsOf(stmt),
      });
    }
  }
}
