import { Address, ExactNumber, ModuleAddress, Schema, State, types, UNKNOWN } from '@clay/contracts';
import {
  AttributeValue,
  CallNode,
  ConfigError,
  EachReference,
  ParsedReference,
  PathReference,
  parseReference,
  Position,
  ReferenceNode,
  spellNamed,
  spellReference,
  Step,
  TemplatePart,
} from '@clay/parser';

import { Instances } from '../Instances';
import { functionCalled } from '../functions';
import { Context, instanceKeyOf, ModuleCall, moduleOf, scopeOf } from '../keys';
import { ModuleInstances } from '../ModuleInstances';
import { Planned } from '../Planned';
import { ScopeManager } from '../scope/ScopeManager';
import { described, Value, valueOf } from '../Value';
import { DataSourceResolver } from './DataSourceResolver';
import { COUNT_INDEX_OUTSIDE, eachOutside } from './instance';
import { ModuleOutputResolver } from './ModuleOutputResolver';
import { UnresolvedReferenceError } from './UnresolvedReferenceError';
import { readPath } from './readPath';
import { ResourceResolver } from './ResourceResolver';
import { VariableResolver } from './VariableResolver';

const LITERALS = { String: types.string, Number: types.number, Boolean: types.bool };

/** A literal's value with its type; `null` is null of no type yet. */
function literal(node: Extract<AttributeValue, { type: 'String' | 'Number' | 'Boolean' | 'Null' }>): Value {
  return node.type === 'Null' ? valueOf(types.dynamic, null) : valueOf(LITERALS[node.type], node.value);
}

/** The instance of a resource or of a module being made names its index; anything else read outside one has none. */
function countIndex(where: Context, position: Position): Value {
  const key = instanceKeyOf(where);
  if (typeof key !== 'number') throw new ConfigError(COUNT_INDEX_OUTSIDE, position);

  return valueOf(types.number, ExactNumber.parse(String(key)));
}

export class ReferenceResolver {
  private scopeManager: ScopeManager;
  private instances: Instances;
  private planned: Planned;
  private modules: ModuleInstances;
  private variables: VariableResolver;
  private dataSources: DataSourceResolver;
  private moduleOutputs: ModuleOutputResolver;
  private resources: ResourceResolver;

  constructor(
    scopeManager: ScopeManager,
    dataSources: Map<string, Record<string, Value>>,
    schemas: Map<string, Schema>,
    instances: Instances,
    modules: ModuleInstances,
    planned: Planned
  ) {
    this.scopeManager = scopeManager;
    this.instances = instances;
    this.planned = planned;
    this.modules = modules;
    this.variables = new VariableResolver(scopeManager, this);
    this.dataSources = new DataSourceResolver(dataSources);
    this.moduleOutputs = new ModuleOutputResolver(scopeManager, modules);
    this.resources = new ResourceResolver(instances, planned, schemas);
  }

  private resolve(node: ReferenceNode, state: State, context?: Context): Value {
    const { value, path } = this.resolveTarget(parseReference(node.value), state, context ?? ModuleAddress.root, node.position);
    const target = node.value.slice(0, node.value.length - path.length);

    return readPath(value, spellReference(target), path, node.position);
  }

  /** The function is found before its argument is read, so a name no function has is refused whatever the argument is. */
  private resolveCall(node: CallNode, state: State, context?: Context): Value {
    const result = functionCalled(node)(this.resolveItem(node.args[0], state, context));

    return readPath(result, spellNamed({ ...node, path: [] }), node.path, node.position);
  }

  /** What the reference names, and the steps still to take into it. */
  private resolveTarget(reference: ParsedReference, state: State, where: Context, position: Position): { value: Value; path: Step[] } {
    if (reference.kind === 'variable') return { value: this.variables.resolve(reference, where, state), path: reference.path };
    if (reference.kind === 'data') return { value: this.dataSources.resolve(reference, where), path: reference.path };
    if (reference.kind === 'module') return this.moduleOutputs.resolve(reference, where, position);
    if (reference.kind === 'count') return { value: countIndex(where, position), path: reference.path };
    if (reference.kind === 'each') return { value: this.each(reference, where, position), path: reference.path };
    if (reference.kind === 'path') return { value: valueOf(types.string, this.directory(reference, where)), path: reference.path };

    return this.resources.resolve(reference, where, state, position);
  }

  /** The instance of a resource or of a module being made names its key, and the value for_each gives that key; anything else read outside one has neither. */
  private each(reference: EachReference, where: Context, position: Position): Value {
    const key = instanceKeyOf(where);
    if (typeof key !== 'string') throw new ConfigError(eachOutside(reference.name), position);
    if (reference.name === 'key') return valueOf(types.string, key);

    // Only an instance of a resource or a module call has a key, and its for_each is read before anything in the instance is.
    const value = where instanceof ModuleCall ? this.modules.eachValue(where.call, key) : this.instances.eachValue((where as Address).withoutKey().toString(), key);
    if (value === undefined) throw new Error(`each.value of "${key}" was read before its for_each`);

    return value;
  }

  /** A module's directory is where its config sits, relative to the root, so a state or a plan made on one machine reads the same on another. */
  private directory(reference: PathReference, where: Context): string {
    if (reference.name === 'root') return '.';

    // Every module the config calls was loaded, and its directory kept, before anything in it is read.
    return this.scopeManager.getDirectory(scopeOf(moduleOf(where).withoutKeys()))!;
  }

  /** A block's values, each with its type. */
  resolveAttributes(attributes: Record<string, AttributeValue>, state: State, context?: Context): Record<string, Value> {
    return Object.fromEntries(Object.entries(attributes).map(([name, value]) => [name, this.resolveValue(value, state, context)]));
  }

  /** A literal list is a tuple and a literal map an object, each item with the type it has. */
  resolveValue(node: AttributeValue, state: State, context?: Context): Value {
    if (node.type === 'Reference') return this.resolve(node, state, context);
    if (node.type === 'Call') return this.resolveCall(node, state, context);
    if (node.type === 'Template') return this.resolveTemplate(node.value, state, context);
    if (node.type === 'List') return this.resolveList(node.value, state, context);
    if (node.type === 'Map') return this.resolveMap(node.value, state, context);

    return literal(node);
  }

  private resolveList(items: AttributeValue[], state: State, context?: Context): Value {
    const values = items.map((item) => this.resolveItem(item, state, context));

    return valueOf(
      types.tuple(values.map((item) => item.type)),
      values.map((item) => item.data)
    );
  }

  private resolveMap(entries: Record<string, AttributeValue>, state: State, context?: Context): Value {
    const values = Object.entries(entries).map(([key, item]) => [key, this.resolveItem(item, state, context)] as const);

    return valueOf(types.object(Object.fromEntries(values.map(([key, item]) => [key, item.type]))), Object.fromEntries(values.map(([key, item]) => [key, item.data])));
  }

  /** At plan time an item only an apply can read is UNKNOWN on its own, of the type it will have, so the list or map around it keeps what is known. */
  private resolveItem(value: AttributeValue, state: State, context?: Context): Value {
    try {
      return this.resolveValue(value, state, context);
    } catch (error) {
      if (!(error instanceof UnresolvedReferenceError && this.planned.isPlanning())) throw error;
      return valueOf(error.type, UNKNOWN);
    }
  }

  /** A template that is one interpolation is the value itself, type and all; text around it makes it a string, which is not known while a part is not. */
  private resolveTemplate(parts: TemplatePart[], state: State, context?: Context): Value {
    const [first] = parts;
    if (parts.length === 1 && typeof first !== 'string') return this.resolveValue(first, state, context);

    try {
      return valueOf(types.string, parts.map((part) => (typeof part === 'string' ? part : this.joined(part, state, context))).join(''));
    } catch (error) {
      if (!(error instanceof UnresolvedReferenceError)) throw error;
      throw new UnresolvedReferenceError(error.message, types.string);
    }
  }

  /** Only a string, a number or a boolean has a text to join. */
  private joined(part: ReferenceNode | CallNode, state: State, context?: Context): string {
    const resolved = this.resolveValue(part, state, context);
    const { kind } = resolved.type;
    if (resolved.data === null || (kind !== 'string' && kind !== 'number' && kind !== 'bool'))
      throw new ConfigError(`${spellNamed(part)} is ${described(resolved)} and cannot be joined into a string`, part.position);

    return String(resolved.data);
  }
}
