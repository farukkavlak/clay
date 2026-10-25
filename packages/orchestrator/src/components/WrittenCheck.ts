import { ModuleAddress, Schema } from '@clay/contracts';
import { Graph } from '@clay/graph';
import { AttributeValue, DataBlock, ModuleBlock, OutputBlock, ResourceBlock, spell, VariableBlock } from '@clay/parser';

import { converted } from '../conformValues';
import { countFrom } from '../count';
import { declaredOf, givenTo } from '../declared';
import { eachFrom } from '../forEach';
import { Context, ModuleCall, scopeOf } from '../keys';
import { NotKnownYet } from '../NotKnownYet';
import { tryAt, withPlace } from '../place';
import { hidingReason } from '../providerResult';
import { ProviderRegistry } from '../ProviderRegistry';
import { ReferenceResolver } from '../resolvers/ReferenceResolver';
import { marksOf } from '../schemaMarks';
import { ScopeManager } from '../scope/ScopeManager';
import { checkWritten } from '../validations';
import { plainOf, Value } from '../Value';
import { GraphNode } from './DependencyGraphBuilder';
import { LoadedModule, LoadedResource } from './ModuleLoader';

/** Checks every value once as written, so a block is checked even when it makes no instance. */
export class WrittenCheck {
  constructor(
    private resolver: ReferenceResolver,
    private scopeManager: ScopeManager,
    private schemas: Map<string, Schema>,
    private dataSchemas: Map<string, Schema>,
    private providers: ProviderRegistry
  ) {}

  /** Runs after names are checked, so each has a type in its schema. */
  async check(loadedResources: LoadedResource[], loadedModules: LoadedModule[], graph: Graph<GraphNode>): Promise<void> {
    await this.checkBlocks(loadedResources, graph);

    for (const { address, program } of loadedModules)
      for (const stmt of program) {
        if (stmt.type === 'Output') this.checkOutput(stmt, address);
        if (stmt.type === 'Variable') this.checkVariable(stmt, address);
        if (stmt.type === 'Module') this.checkCall(stmt, address.child(stmt.name));
      }
  }

  /** Each after the locals and blocks it reads, so no check reads down a chain of them, which can be longer than the call stack. */
  private async checkBlocks(loadedResources: LoadedResource[], graph: Graph<GraphNode>): Promise<void> {
    const resources = new Map(loadedResources.map((loaded) => [loaded.uniqueId, loaded]));

    for (const key of graph.topologicalSort().flat()) {
      const node = graph.getNode(key)!;
      if (node.kind === 'local') this.read(node.value, node.declaration, node.module);
      if (node.kind === 'resource') await this.checkResource(resources.get(key)!);
      if (node.kind === 'data') await this.checkData(node.block, node.module);
    }
  }

  private async checkResource({ address, block }: LoadedResource): Promise<void> {
    const declaration = spell(block);
    // Every schema is loaded by now.
    const schema = this.schemas.get(block.resourceType)!;

    this.checkRepetition(block, declaration, address);
    const given = this.checkAttributes(block.resourceType, block.attributes, schema, declaration, address);
    await this.askProvider(block, block.resourceType, given, schema, address, (type, config) => this.providers.get(type).validate(type, config));
  }

  private async checkData(block: DataBlock, module: ModuleAddress): Promise<void> {
    const declaration = spell(block);
    // Every data schema is loaded by now, its names checked.
    const schema = this.dataSchemas.get(block.dataSourceType)!;

    this.checkRepetition(block, declaration, module);
    const given = this.checkAttributes(block.dataSourceType, block.attributes, schema, declaration, module);
    await this.askProvider(block, block.dataSourceType, given, schema, module, (type, config) => this.providers.reader(type).validateDataSource(type, config));
  }

  /** As the provider receives them: a null sets nothing. */
  private checkAttributes(type: string, attributes: Record<string, AttributeValue>, schema: Schema, declaration: string, context: Context): Record<string, Value> {
    const given: Record<string, Value> = {};

    for (const [name, value] of Object.entries(attributes)) {
      const read = this.read(value, declaration, context);
      const typed = tryAt(value.position, declaration, context, () => converted(type, read, schema[name].type, [name]));
      if (typed.data !== null) given[name] = typed;
    }

    return given;
  }

  /** A value not known yet reaches the provider as unknown, so a block is checked by its provider even when it makes no instance. */
  private async askProvider(
    block: ResourceBlock | DataBlock,
    type: string,
    given: Record<string, Value>,
    schema: Schema,
    context: Context,
    validate: (type: string, config: Record<string, unknown>) => Promise<void>
  ): Promise<void> {
    try {
      await hidingReason(type, marksOf(schema, given), () => validate(type, plainOf(given)));
    } catch (error) {
      throw withPlace(error, block.position, spell(block), context);
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
