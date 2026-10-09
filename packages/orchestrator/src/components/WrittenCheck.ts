import { ModuleAddress, Schema } from '@clay/contracts';
import { AttributeValue, DataBlock, ModuleBlock, OutputBlock, spell } from '@clay/parser';

import { converted } from '../conformValues';
import { declaredOf, givenTo } from '../declared';
import { Context, ModuleCall, scopeOf } from '../keys';
import { tryAt } from '../place';
import { ReferenceResolver } from '../resolvers/ReferenceResolver';
import { ScopeManager } from '../scope/ScopeManager';
import { Value } from '../Value';
import { LoadedModule, LoadedResource } from './ModuleLoader';

/** Checks every value once with references unknown, so a block is checked even when it makes no instance. */
export class WrittenCheck {
  constructor(
    private resolver: ReferenceResolver,
    private scopeManager: ScopeManager,
    private schemas: Map<string, Schema>,
    private dataSchemas: Map<string, Schema>
  ) {}

  /** Runs after names are checked, so each has a type in its schema. */
  check(loadedResources: LoadedResource[], loadedModules: LoadedModule[]): void {
    for (const loaded of loadedResources) this.checkResource(loaded);

    for (const { address, program } of loadedModules)
      for (const stmt of program) {
        if (stmt.type === 'Output') this.checkOutput(stmt, address);
        if (stmt.type === 'Data') this.checkData(stmt, address);
        if (stmt.type === 'Variable' && stmt.attributes.default) this.checkGiven(stmt.name, stmt.attributes.default, spell(stmt), address, address);
        if (stmt.type === 'Module') this.checkCall(stmt, address.child(stmt.name));
      }
  }

  private checkResource({ address, block }: LoadedResource): void {
    const declaration = spell(block);
    // Every schema is loaded by now.
    const schema = this.schemas.get(block.resourceType)!;

    for (const value of [block.count, block.forEach]) if (value) this.read(value, declaration, address);
    this.checkAttributes(block.resourceType, block.attributes, schema, declaration, address);
  }

  private checkData(block: DataBlock, module: ModuleAddress): void {
    // Every data schema is loaded by now, its names checked.
    this.checkAttributes(block.dataSourceType, block.attributes, this.dataSchemas.get(block.dataSourceType)!, spell(block), module);
  }

  private checkAttributes(type: string, attributes: Record<string, AttributeValue>, schema: Schema, declaration: string, context: Context): void {
    for (const [name, value] of Object.entries(attributes)) {
      const read = this.read(value, declaration, context);
      tryAt(value.position, declaration, context, () => converted(type, read, schema[name].type, [name]));
    }
  }

  private checkCall(block: ModuleBlock, module: ModuleAddress): void {
    const declaration = spell(block);
    const call = new ModuleCall(module);

    for (const value of [block.count, block.forEach]) if (value) this.read(value, declaration, call.caller);
    // `source` is checked too: it is a string, and no variable may take that name.
    for (const [name, value] of Object.entries(block.attributes)) this.checkGiven(name, value, declaration, call, module);
  }

  private checkOutput(block: OutputBlock, module: ModuleAddress): void {
    const declaration = spell(block);
    const read = this.read(block.value, declaration, module);
    tryAt(block.value.position, declaration, module, () => givenTo('output', block.name, read, declaredOf(block), (node) => this.read(node, declaration, module)));
  }

  private checkGiven(name: string, value: AttributeValue, declaration: string, context: Context, module: ModuleAddress): void {
    const read = this.read(value, declaration, context);
    const declared = this.scopeManager.getVariable(scopeOf(module), name) ?? {};
    tryAt(value.position, declaration, context, () => givenTo('variable', name, read, declared, (node) => this.read(node, declaration, module)));
  }

  private read(value: AttributeValue, declaration: string, context: Context): Value {
    return tryAt(value.position, declaration, context, () => this.resolver.readAsWritten(value, context));
  }
}
