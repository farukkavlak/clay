import { AttributeValue, CONFIG_FILE, Lexer, Parser, ResourceBlock, Statement } from '@clay/parser';
import path from 'node:path';

import { Address } from '../Address';
import { ConfigFiles } from '../ConfigFiles';

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
    private processVariables: (program: Statement[], address: Address) => void,
    private initializeChildVariables: (childAddress: Address, attributesMap: Record<string, unknown>, parentAddress: Address) => void,
    private getAttributesMap: (attributes: Record<string, AttributeValue> | undefined) => Record<string, unknown>
  ) {}

  async loadModuleTree(rootProgram: Statement[]): Promise<{ resources: LoadedResource[]; modules: LoadedModule[] }> {
    const loadedResources: LoadedResource[] = [];
    const loadedModules: LoadedModule[] = [];

    const parentAddress = new Address([], '', '');
    loadedModules.push({ address: parentAddress, program: rootProgram });
    this.processVariables(rootProgram, parentAddress);

    for (const stmt of rootProgram)
      if (stmt.type === 'Resource') {
        const address = new Address([], stmt.resourceType, stmt.name);
        loadedResources.push({ uniqueId: address.toString(), address, block: stmt });
      } else if (stmt.type === 'Module') {
        const childResources = await this.loadChildModule(stmt, '', parentAddress, loadedModules);
        loadedResources.push(...childResources);
      }

    return { resources: loadedResources, modules: loadedModules };
  }

  private async loadChildModule(stmt: Statement, parentDir: string, parentAddress: Address, moduleAccumulator: LoadedModule[]): Promise<LoadedResource[]> {
    if (stmt.type !== 'Module') return [];

    const moduleName = stmt.name;
    const attributesMap = this.getAttributesMap(stmt.attributes);

    const sourceValue = (attributesMap.source as { value: unknown } | undefined)?.value;
    if (typeof sourceValue !== 'string') throw new Error(`Module "${moduleName}" is missing a valid "source" attribute.`);

    const moduleDir = path.posix.join(parentDir, sourceValue);
    const moduleProgram = this.parseModuleFile(moduleDir);

    const childAddress = new Address([...parentAddress.modulePath, moduleName], '', '');
    this.initializeChildVariables(childAddress, attributesMap, parentAddress);

    moduleAccumulator.push({ address: childAddress, program: moduleProgram });
    this.processVariables(moduleProgram, childAddress);

    const childResources: LoadedResource[] = [];
    for (const childStmt of moduleProgram)
      if (childStmt.type === 'Resource') {
        const resourceAddress = new Address(childAddress.modulePath, childStmt.resourceType, childStmt.name);
        childResources.push({ uniqueId: resourceAddress.toString(), address: resourceAddress, block: childStmt });
      } else if (childStmt.type === 'Module') {
        const nestedResources = await this.loadChildModule(childStmt, moduleDir, childAddress, moduleAccumulator);
        childResources.push(...nestedResources);
      }

    return childResources;
  }

  private parseModuleFile(moduleDir: string): Statement[] {
    const moduleFile = path.posix.join(moduleDir, CONFIG_FILE);
    const moduleContent = this.files.read(moduleFile);
    if (moduleContent === undefined) throw new Error(`Module source not found at: ${moduleFile}`);

    const parser = new Parser(new Lexer(moduleContent).tokenize());
    return parser.parse() || [];
  }
}
