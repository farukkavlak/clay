import { ModuleAddress, Schema } from '@clay/contracts';
import { Graph } from '@clay/graph';
import { AttributeValue, DataBlock, ModuleBlock, OutputBlock, ResourceBlock, spell, VariableBlock } from '@clay/parser';

import { converted } from '../values/conformValues';
import { countFrom } from '../instances/count';
import { declaredOf, givenTo } from '../values/declared';
import { eachFrom } from '../instances/forEach';
import { Context, DataInstance, ModuleCall, scopeOf } from '../keys';
import { NotKnownYet } from '../instances/NotKnownYet';
import { tryAt, withPlace } from '../place';
import { hidingReason } from '../providers/providerResult';
import { ProviderRegistry } from '../providers/ProviderRegistry';
import { inOrder, Limit } from '../providers/Limit';
import { ReferenceResolver } from '../expressions/ReferenceResolver';
import { marksOf } from '../values/schemaMarks';
import { ScopeManager } from '../config/ScopeManager';
import { checkWritten } from '../expressions/validations';
import { plainOf, Value } from '../values/Value';
import { GraphNode } from '../graph/DependencyGraphBuilder';
import { LoadedModule, LoadedResource } from '../config/ModuleLoader';

/** Checks every value once as written, so a block is checked even when it makes no instance. */
export class WrittenCheck {
  constructor(
    private resolver: ReferenceResolver,
    private scopeManager: ScopeManager,
    private schemas: Map<string, Schema>,
    private dataSchemas: Map<string, Schema>,
    private providers: ProviderRegistry,
    private limit: Limit
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

  /**
   * Each after the locals and blocks it reads, so no check reads down a chain of them, which can be longer than the call stack.
   * The checks stop at the first that fails; providers are asked all at once, and an earlier refusal of theirs comes first.
   */
  private async checkBlocks(loadedResources: LoadedResource[], graph: Graph<GraphNode>): Promise<void> {
    const resources = new Map(loadedResources.map((loaded) => [loaded.uniqueId, loaded]));
    const asked: Promise<void>[] = [];

    try {
      for (const key of graph.topologicalSort().flat()) asked.push(this.checkNode(graph.getNode(key)!, key, resources));
    } catch (error) {
      await inOrder(asked);
      throw error;
    }
    await inOrder(asked);
  }

  /** The provider's answer, once the rest is checked. */
  private checkNode(node: GraphNode, key: string, resources: Map<string, LoadedResource>): Promise<void> {
    if (node.kind === 'local') this.read(node.value, node.declaration, node.module);
    if (node.kind === 'resource') return this.checkResource(resources.get(key)!);
    if (node.kind === 'data') return this.checkData(node.block, node.module);

    return Promise.resolve();
  }

  private checkResource({ address, block }: LoadedResource): Promise<void> {
    const declaration = spell(block);
    // Every schema is loaded by now.
    const schema = this.schemas.get(block.resourceType)!;

    this.checkRepetition(block, declaration, address);
    const given = this.checkAttributes(block.resourceType, block.attributes, schema, declaration, address);
    return this.askProvider(block, block.resourceType, given, schema, address, (type, config) => this.providers.get(type).validate(type, config));
  }

  private checkData(block: DataBlock, module: ModuleAddress): Promise<void> {
    const declaration = spell(block);
    // Every data schema is loaded by now, its names checked.
    const schema = this.dataSchemas.get(block.dataSourceType)!;

    this.checkRepetition(block, declaration, module);
    // In the block, so `each.value` finds its for_each.
    const given = this.checkAttributes(block.dataSourceType, block.attributes, schema, declaration, new DataInstance(module, block.dataSourceType, block.name));
    return this.askProvider(block, block.dataSourceType, given, schema, module, (type, config) => this.providers.reader(type).validateDataSource(type, config));
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
      await this.limit.run(() => hidingReason(type, marksOf(schema, given), () => validate(type, plainOf(given))));
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
