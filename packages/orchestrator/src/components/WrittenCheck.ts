import { ModuleAddress, Schema } from '@clay/contracts';
import { Graph } from '@clay/graph';
import { AttributeValue, DataBlock, ModuleBlock, OutputBlock, spell, VariableBlock } from '@clay/parser';

import { converted } from '../conformValues';
import { countFrom } from '../count';
import { declaredOf, givenTo } from '../declared';
import { eachFrom } from '../forEach';
import { Context, ModuleCall, scopeOf } from '../keys';
import { NotKnownYet } from '../NotKnownYet';
import { tryAt } from '../place';
import { ReferenceResolver } from '../resolvers/ReferenceResolver';
import { ScopeManager } from '../scope/ScopeManager';
import { checkWritten } from '../validations';
import { Value } from '../Value';
import { GraphNode } from './DependencyGraphBuilder';
import { LoadedModule, LoadedResource } from './ModuleLoader';

/** Checks every value once as written, so a block is checked even when it makes no instance. */
export class WrittenCheck {
  constructor(
    private resolver: ReferenceResolver,
    private scopeManager: ScopeManager,
    private schemas: Map<string, Schema>,
    private dataSchemas: Map<string, Schema>
  ) {}

  /** Runs after names are checked, so each has a type in its schema. */
  check(loadedResources: LoadedResource[], loadedModules: LoadedModule[], graph: Graph<GraphNode>): void {
    this.checkLocals(graph);
    for (const loaded of loadedResources) this.checkResource(loaded);

    for (const { address, program } of loadedModules)
      for (const stmt of program) {
        if (stmt.type === 'Output') this.checkOutput(stmt, address);
        if (stmt.type === 'Data') this.checkData(stmt, address);
        if (stmt.type === 'Variable') this.checkVariable(stmt, address);
        if (stmt.type === 'Module') this.checkCall(stmt, address.child(stmt.name));
      }
  }

  /** Each after the locals it reads, so no check reads down a chain of them, which can be longer than the call stack. */
  private checkLocals(graph: Graph<GraphNode>): void {
    for (const key of graph.topologicalSort().flat()) {
      const node = graph.getNode(key)!;
      if (node.kind === 'local') this.read(node.value, node.declaration, node.module);
    }
  }

  private checkResource({ address, block }: LoadedResource): void {
    const declaration = spell(block);
    // Every schema is loaded by now.
    const schema = this.schemas.get(block.resourceType)!;

    this.checkRepetition(block, declaration, address);
    this.checkAttributes(block.resourceType, block.attributes, schema, declaration, address);
  }

  private checkData(block: DataBlock, module: ModuleAddress): void {
    const declaration = spell(block);

    this.checkRepetition(block, declaration, module);
    // Every data schema is loaded by now, its names checked.
    this.checkAttributes(block.dataSourceType, block.attributes, this.dataSchemas.get(block.dataSourceType)!, declaration, module);
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

    this.checkRepetition(block, declaration, call.caller);
    // `source` is checked too: it is a string, and no variable may take that name.
    for (const [name, value] of Object.entries(block.attributes)) this.checkGiven(name, value, declaration, call, module);
  }

  private checkOutput(block: OutputBlock, module: ModuleAddress): void {
    const declaration = spell(block);
    const read = this.read(block.value, declaration, module);
    tryAt(block.value.position, declaration, module, () => givenTo('output', block.name, read, declaredOf(block), (node) => this.read(node, declaration, module)));
  }

  /** Its rules are read in the module that declares it, as each instance's are. */
  private checkVariable(variable: VariableBlock, module: ModuleAddress): void {
    const declaration = spell(variable);

    if (variable.attributes.default) this.checkGiven(variable.name, variable.attributes.default, declaration, module, module);
    for (const rule of variable.validations ?? []) tryAt(rule.position, declaration, module, () => checkWritten(rule, (node) => this.read(node, declaration, module)));
  }

  private checkRepetition({ count, forEach }: { count?: AttributeValue; forEach?: AttributeValue }, declaration: string, context: Context): void {
    if (count) this.checkInstances(count, countFrom, declaration, context);
    if (forEach) this.checkInstances(forEach, eachFrom, declaration, context);
  }

  /** A mark from a branch an instance may not take is one it may have, and only a mark for certain refuses. */
  private checkInstances(value: AttributeValue, instancesFrom: (read: Value) => unknown, declaration: string, context: Context): void {
    const read = this.read(value, declaration, context);
    tryAt(value.position, declaration, context, () => {
      try {
        instancesFrom(read);
      } catch (error) {
        if (!(error instanceof NotKnownYet)) throw error;
      }
    });
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
