import { ModuleAddress, Schema } from '@clay/contracts';
import { AttributeValue, ModuleBlock, spell, VariableBlock } from '@clay/parser';

import { converted } from '../conformValues';
import { checkDefaults, givenTo } from '../declared';
import { Context, ModuleCall, scopeOf } from '../keys';
import { tryAt } from '../place';
import { ReferenceResolver } from '../resolvers/ReferenceResolver';
import { ScopeManager } from '../scope/ScopeManager';
import { Value } from '../Value';
import { LoadedModule, LoadedResource } from './ModuleLoader';

/** Reads every value once as written, each reference in it not known yet, and holds it to the type it is given to, so a block is checked whatever instances it makes, none included. */
export class WrittenCheck {
  constructor(
    private resolver: ReferenceResolver,
    private scopeManager: ScopeManager,
    private schemas: Map<string, Schema>
  ) {}

  /** Run once the names a resource sets are checked, so each has a type in its schema. */
  check(loadedResources: LoadedResource[], loadedModules: LoadedModule[]): void {
    for (const loaded of loadedResources) this.checkResource(loaded);

    for (const { address, program } of loadedModules)
      for (const stmt of program) {
        if (stmt.type === 'Output') this.read(stmt.value, spell(stmt), address);
        if (stmt.type === 'Variable') this.checkVariable(stmt, address);
        if (stmt.type === 'Module') this.checkCall(stmt, address.child(stmt.name));
      }
  }

  private checkResource({ address, block }: LoadedResource): void {
    const declaration = spell(block);
    // Every resource type's schema is read at load.
    const schema = this.schemas.get(block.resourceType)!;

    for (const value of [block.count, block.forEach]) if (value) this.read(value, declaration, address);
    for (const [name, value] of Object.entries(block.attributes)) {
      const read = this.read(value, declaration, address);
      tryAt(value.position, declaration, address, () => converted(block.resourceType, read, schema[name].type, [name]));
    }
  }

  /** A call's count and for_each are read in the module that calls; an input in the call, given to the module's variable. */
  private checkCall(block: ModuleBlock, module: ModuleAddress): void {
    const declaration = spell(block);
    const call = new ModuleCall(module);

    for (const value of [block.count, block.forEach]) if (value) this.read(value, declaration, call.caller);
    // `source` is read too: it is a string, and no module declares a variable by that name.
    for (const [name, value] of Object.entries(block.attributes)) this.checkGiven(name, value, declaration, call, module);
  }

  /** Its default, and each default its type gives an optional attribute, though no value takes them. */
  private checkVariable(block: VariableBlock, module: ModuleAddress): void {
    const declaration = spell(block);
    if (block.attributes.default) this.checkGiven(block.name, block.attributes.default, declaration, module, module);

    const read = (node: AttributeValue) => this.read(node, declaration, module);
    if (block.valueType && block.defaults)
      checkDefaults(block.name, block.valueType, { tree: block.defaults, read }, (node, check) => tryAt(node.position, declaration, module, check));
  }

  /** A value given to a variable, held to the type the variable names. */
  private checkGiven(name: string, value: AttributeValue, declaration: string, context: Context, module: ModuleAddress): void {
    const read = this.read(value, declaration, context);
    const declared = this.scopeManager.getVariable(scopeOf(module), name) ?? {};
    tryAt(value.position, declaration, context, () => givenTo(name, read, declared, (node) => this.read(node, declaration, module)));
  }

  private read(value: AttributeValue, declaration: string, context: Context): Value {
    return tryAt(value.position, declaration, context, () => this.resolver.readAsWritten(value, context));
  }
}
