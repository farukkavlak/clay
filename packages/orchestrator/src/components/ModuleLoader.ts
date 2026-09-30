import { Address, ModuleAddress } from '@clay/contracts';
import { CONFIG_FILE, ConfigError, Lexer, ModuleBlock, Parser, ResourceBlock, Statement, spell } from '@clay/parser';
import path from 'node:path';

import { ConfigFiles } from '../ConfigFiles';
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

/** What the loader has found so far; each module adds to it where it is called. */
export interface Loaded {
  resources: LoadedResource[];
  modules: LoadedModule[];
}

export class ModuleLoader {
  constructor(
    private files: ConfigFiles,
    private scopeManager: ScopeManager
  ) {}

  async loadModuleTree(rootProgram: Statement[]): Promise<Loaded> {
    const loaded: Loaded = { resources: [], modules: [] };

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

    const sourceValue = stmt.attributes.source?.value;
    if (typeof sourceValue !== 'string') throw new Error(`Module "${moduleName}" is missing a valid "source" attribute.`);

    // The trailing "." leaves one spelling per directory, so a cycle is seen on the hop that closes it.
    const moduleDir = path.posix.join(parentDir, sourceValue, '.');
    if (loadingDirs.includes(moduleDir)) throw new Error(`Module source cycle detected: ${[...loadingDirs, moduleDir].join(' -> ')}`);

    const moduleProgram = this.parseModuleFile(moduleDir);

    const childAddress = parentAddress.child(moduleName);
    this.declareInputs(stmt, moduleProgram, childAddress, parentAddress);

    loaded.modules.push({ address: childAddress, program: moduleProgram });
    this.scopeManager.setDirectory(scopeOf(childAddress), moduleDir);
    this.declareVariables(moduleProgram, childAddress);

    for (const childStmt of moduleProgram)
      if (childStmt.type === 'Resource') {
        const resourceAddress = new Address(childAddress, childStmt.resourceType, childStmt.name);
        loaded.resources.push({ uniqueId: resourceAddress.toString(), address: resourceAddress, block: childStmt });
      } else if (childStmt.type === 'Module') await this.loadChildModule(childStmt, moduleDir, childAddress, loaded, [...loadingDirs, moduleDir]);
  }

  private parseModuleFile(moduleDir: string): Statement[] {
    const moduleFile = path.posix.join(moduleDir, CONFIG_FILE);
    const moduleContent = this.files.read(moduleFile);
    if (moduleContent === undefined) throw new Error(`Module source not found at: ${moduleFile}`);

    return new Parser(new Lexer(moduleContent, moduleFile).tokenize()).parse();
  }

  // An input is read in the call.
  private declareInputs(stmt: ModuleBlock, program: Statement[], childAddress: ModuleAddress, parentAddress: ModuleAddress): void {
    const declared = new Set(program.filter((moduleStmt) => moduleStmt.type === 'Variable').map((variable) => variable.name));
    const childScope = scopeOf(childAddress);

    for (const [key, value] of Object.entries(stmt.attributes)) {
      if (key === 'source') continue;
      if (!declared.has(key))
        throw new ConfigError(`module "${stmt.name}" has no variable "${key}"`, value.position, { block: spell(stmt), module: scopeOf(parentAddress) || undefined });

      this.scopeManager.setVariable(childScope, key, { value, context: new ModuleCall(childAddress) });
    }
  }

  private declareVariables(program: Statement[], address: ModuleAddress): void {
    const scope = scopeOf(address);

    // A caller's input beats the default; neither one is a missing input, read or not.
    for (const stmt of program) {
      if (stmt.type !== 'Variable' || this.scopeManager.getVariable(scope, stmt.name)) continue;
      if (stmt.attributes.default === undefined) throw new Error(`${scope ? `${scope}: ` : ''}variable "${stmt.name}" has no value`);

      this.scopeManager.setVariable(scope, stmt.name, { value: stmt.attributes.default, context: address });
    }
  }
}
