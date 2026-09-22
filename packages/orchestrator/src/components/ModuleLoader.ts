import { Address } from '@clay/contracts';
import { CONFIG_FILE, ConfigError, Lexer, ModuleBlock, Parser, ResourceBlock, Statement, spell } from '@clay/parser';
import path from 'node:path';

import { ConfigFiles } from '../ConfigFiles';
import { scopeOf } from '../keys';
import { ScopeManager } from '../scope/ScopeManager';

export interface LoadedResource {
  uniqueId: string;
  address: Address;
  block: ResourceBlock;
}

export interface LoadedModule {
  address: Address;
  program: Statement[];
}

export class ModuleLoader {
  constructor(
    private files: ConfigFiles,
    private scopeManager: ScopeManager
  ) {}

  async loadModuleTree(rootProgram: Statement[]): Promise<{ resources: LoadedResource[]; modules: LoadedModule[] }> {
    const loadedResources: LoadedResource[] = [];
    const loadedModules: LoadedModule[] = [];

    const parentAddress = new Address([], '', '');
    loadedModules.push({ address: parentAddress, program: rootProgram });
    this.declareVariables(rootProgram, parentAddress);

    for (const stmt of rootProgram)
      if (stmt.type === 'Resource') {
        const address = new Address([], stmt.resourceType, stmt.name);
        loadedResources.push({ uniqueId: address.toString(), address, block: stmt });
      } else if (stmt.type === 'Module') {
        const childResources = await this.loadChildModule(stmt, '.', parentAddress, loadedModules, ['.']);
        loadedResources.push(...childResources);
      }

    return { resources: loadedResources, modules: loadedModules };
  }

  private async loadChildModule(stmt: ModuleBlock, parentDir: string, parentAddress: Address, moduleAccumulator: LoadedModule[], loadingDirs: string[]): Promise<LoadedResource[]> {
    const moduleName = stmt.name;

    const sourceValue = stmt.attributes.source?.value;
    if (typeof sourceValue !== 'string') throw new Error(`Module "${moduleName}" is missing a valid "source" attribute.`);

    // The trailing "." leaves one spelling per directory, so a cycle is seen on the hop that closes it.
    const moduleDir = path.posix.join(parentDir, sourceValue, '.');
    if (loadingDirs.includes(moduleDir)) throw new Error(`Module source cycle detected: ${[...loadingDirs, moduleDir].join(' -> ')}`);

    const moduleProgram = this.parseModuleFile(moduleDir);

    const childAddress = new Address([...parentAddress.modulePath, moduleName], '', '');
    this.declareInputs(stmt, moduleProgram, childAddress, parentAddress);

    moduleAccumulator.push({ address: childAddress, program: moduleProgram });
    this.declareVariables(moduleProgram, childAddress);

    const childResources: LoadedResource[] = [];
    for (const childStmt of moduleProgram)
      if (childStmt.type === 'Resource') {
        const resourceAddress = new Address(childAddress.modulePath, childStmt.resourceType, childStmt.name);
        childResources.push({ uniqueId: resourceAddress.toString(), address: resourceAddress, block: childStmt });
      } else if (childStmt.type === 'Module') {
        const nestedResources = await this.loadChildModule(childStmt, moduleDir, childAddress, moduleAccumulator, [...loadingDirs, moduleDir]);
        childResources.push(...nestedResources);
      }

    return childResources;
  }

  private parseModuleFile(moduleDir: string): Statement[] {
    const moduleFile = path.posix.join(moduleDir, CONFIG_FILE);
    const moduleContent = this.files.read(moduleFile);
    if (moduleContent === undefined) throw new Error(`Module source not found at: ${moduleFile}`);

    return new Parser(new Lexer(moduleContent, moduleFile).tokenize()).parse();
  }

  // An input is read where the module is called, so its context is the parent.
  private declareInputs(stmt: ModuleBlock, program: Statement[], childAddress: Address, parentAddress: Address): void {
    const declared = new Set(program.filter((moduleStmt) => moduleStmt.type === 'Variable').map((variable) => variable.name));
    const childScope = scopeOf(childAddress);

    for (const [key, value] of Object.entries(stmt.attributes)) {
      if (key === 'source') continue;
      if (!declared.has(key))
        throw new ConfigError(`module "${stmt.name}" has no variable "${key}"`, value.position, { block: spell(stmt), module: scopeOf(parentAddress) || undefined });

      this.scopeManager.setVariable(childScope, key, { value, context: parentAddress });
    }
  }

  private declareVariables(program: Statement[], address: Address): void {
    const scope = scopeOf(address);

    // A caller's input beats the default; neither one is a missing input, read or not.
    for (const stmt of program) {
      if (stmt.type !== 'Variable' || this.scopeManager.getVariable(scope, stmt.name)) continue;
      if (stmt.attributes.default === undefined) throw new Error(`${scope ? `${scope}: ` : ''}variable "${stmt.name}" has no value`);

      this.scopeManager.setVariable(scope, stmt.name, { value: stmt.attributes.default, context: address });
    }
  }
}
