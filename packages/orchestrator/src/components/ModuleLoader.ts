import { Address, ModuleAddress, Type, types } from '@clay/contracts';
import { CONFIG_FILE, ConfigError, Lexer, ModuleBlock, Parser, ResourceBlock, Statement, spell } from '@clay/parser';
import path from 'node:path';

import { ConfigFiles } from '../ConfigFiles';
import { required } from '../declared';
import { ModuleCall, scopeOf } from '../keys';
import { ScopeManager } from '../scope/ScopeManager';

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

export class ModuleLoader {
  // One load sees one version of a file, however many blocks call its module.
  private contents = new Map<string, string | undefined>();

  constructor(
    private files: ConfigFiles,
    private scopeManager: ScopeManager
  ) {}

  async loadModuleTree(rootProgram: Statement[]): Promise<Loaded> {
    const loaded: Loaded = { resources: [], modules: [] };
    this.contents.clear();

    const parentAddress = ModuleAddress.root;
    loaded.modules.push({ address: parentAddress, program: rootProgram });
    this.scopeManager.setDirectory(scopeOf(parentAddress), '.');
    this.declareVariables(rootProgram, parentAddress);

    for (const stmt of rootProgram)
      if (stmt.type === 'Resource') {
        const address = Address.root(stmt.resourceType, stmt.name);
        loaded.resources.push({ uniqueId: address.toString(), address, block: stmt });
      } else if (stmt.type === 'Module') await this.loadChildModule(stmt, '.', parentAddress, loaded, ['.']);

    return loaded;
  }

  private async loadChildModule(stmt: ModuleBlock, parentDir: string, parentAddress: ModuleAddress, loaded: Loaded, loadingDirs: string[]): Promise<void> {
    const moduleName = stmt.name;
    const { moduleDir, moduleProgram } = this.readModule(stmt, parentDir, parentAddress, loadingDirs);

    const childAddress = parentAddress.child(moduleName);
    this.declareInputs(stmt, moduleProgram, childAddress, parentAddress);

    loaded.modules.push({ address: childAddress, program: moduleProgram });
    this.scopeManager.setDirectory(scopeOf(childAddress), moduleDir);
    this.scopeManager.declareOutputs(scopeOf(childAddress), outputsOf(moduleProgram));
    this.declareVariables(moduleProgram, childAddress);

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

    const moduleProgram = this.parseModuleFile(moduleDir);
    if (moduleProgram === undefined) throw new ConfigError(`Module source not found at: ${path.posix.join(moduleDir, CONFIG_FILE)}`, source.position, place);

    return { moduleDir, moduleProgram };
  }

  private parseModuleFile(moduleDir: string): Statement[] | undefined {
    const moduleFile = path.posix.join(moduleDir, CONFIG_FILE);
    if (!this.contents.has(moduleFile)) this.contents.set(moduleFile, this.files.read(moduleFile));
    const moduleContent = this.contents.get(moduleFile);
    if (moduleContent === undefined) return undefined;

    return new Parser(new Lexer(moduleContent, moduleFile).tokenize()).parse();
  }

  private declareInputs(stmt: ModuleBlock, program: Statement[], childAddress: ModuleAddress, parentAddress: ModuleAddress): void {
    const declared = new Map(program.filter((moduleStmt) => moduleStmt.type === 'Variable').map((variable) => [variable.name, variable]));
    const childScope = scopeOf(childAddress);
    const block = spell(stmt);

    for (const [key, value] of Object.entries(stmt.attributes)) {
      if (key === 'source') continue;
      const variable = declared.get(key);
      if (!variable) throw new ConfigError(`module "${stmt.name}" has no variable "${key}"`, value.position, { block, module: scopeOf(parentAddress) || undefined });

      this.scopeManager.setVariable(childScope, key, { value, context: new ModuleCall(childAddress), type: variable.valueType, defaults: variable.defaults, block });
    }
  }

  private declareVariables(program: Statement[], address: ModuleAddress): void {
    const scope = scopeOf(address);

    // A variable with an input or a default is not missing.
    for (const stmt of program) {
      if (stmt.type !== 'Variable' || this.scopeManager.getVariable(scope, stmt.name)) continue;
      if (stmt.attributes.default === undefined) throw new ConfigError(`variable "${stmt.name}" has no value`, stmt.position, { block: spell(stmt), module: scope || undefined });

      this.scopeManager.setVariable(scope, stmt.name, { value: stmt.attributes.default, context: address, type: stmt.valueType, defaults: stmt.defaults, block: spell(stmt) });
    }
  }
}
