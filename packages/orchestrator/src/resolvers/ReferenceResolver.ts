import { Address, emptyState, ExactNumber, ModuleAddress, Schema, State, types, UNKNOWN } from '@clay/contracts';
import {
  AttributeValue,
  BoundNode,
  CallNode,
  ConfigError,
  EachReference,
  ForNode,
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

import { checkCollection, forItems, ForItem, forObject, unknownItem } from '../forItems';
import { Instances } from '../Instances';
import { functionCalled } from '../functions';
import { Context, instanceKeyOf, ModuleCall, moduleOf, scopeOf } from '../keys';
import { ModuleInstances } from '../ModuleInstances';
import { Planned } from '../Planned';
import { ScopeManager } from '../scope/ScopeManager';
import { described, hasText, objectOf, tupleOf, unordered, Value, valueOf } from '../Value';
import { DataSourceResolver } from './DataSourceResolver';
import { COUNT_INDEX_OUTSIDE, eachOutside } from './instance';
import { ModuleOutputResolver } from './ModuleOutputResolver';
import { UnresolvedReferenceError } from './UnresolvedReferenceError';
import { readPath } from './readPath';
import { ResourceResolver } from './ResourceResolver';
import { VariableResolver } from './VariableResolver';
import { WrittenTypes } from './WrittenTypes';

const LITERALS = { String: types.string, Number: types.number, Boolean: types.bool };

/** A literal's value with its type; `null` is null of no type yet. */
function literal(node: Extract<AttributeValue, { type: 'String' | 'Number' | 'Boolean' | 'Null' }>): Value {
  return node.type === 'Null' ? valueOf(types.dynamic, null) : valueOf(LITERALS[node.type], node.value);
}

/** The values the for expressions around a value give their names, for the item each is reading. */
type Given = ReadonlyMap<string, Value>;

/** How a value is read: with what the for expressions around it give, and with each reference read as not known yet, of the type it will have, where `asWritten`. */
interface Reading {
  given: Given;
  asWritten: boolean;
}

const READING: Reading = { given: new Map(), asWritten: false };

/** The names `node` gives, standing for `item`, beside those the for expressions around it give. */
function withNames(reading: Reading, node: ForNode, [key, value]: ForItem): Reading {
  const names = new Map(reading.given).set(node.valueName, value);

  return { ...reading, given: node.keyName === undefined ? names : names.set(node.keyName, key) };
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
  private written: WrittenTypes;

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
    this.written = new WrittenTypes(scopeManager, schemas, instances);
  }

  private resolve(node: ReferenceNode, state: State, context: Context | undefined, reading: Reading): Value {
    const reference = parseReference(node.value);
    const where = context ?? ModuleAddress.root;
    const { value, path } = reading.asWritten ? this.writtenTarget(reference, where, node.position) : this.resolveTarget(reference, state, where, node.position);
    const target = node.value.slice(0, node.value.length - path.length);

    return readPath(value, spellReference(target), path, node.position);
  }

  /** The function is found before its argument is read, so a name no function has is refused whatever the argument is. */
  private resolveCall(node: CallNode, state: State, context: Context | undefined, reading: Reading): Value {
    const result = functionCalled(node)(this.resolveItem(node.args[0], state, context, reading));

    return readPath(result, spellNamed({ ...node, path: [] }), node.path, node.position);
  }

  /** The parser reads a name as one a for gives only inside that for, so the for has given it a value. */
  private resolveBound(node: BoundNode, given: Given): Value {
    const [name, ...path] = node.value;

    return readPath(given.get(String(name))!, String(name), path, node.position);
  }

  /** The body read once for each item, a tuple of what each comes to, or with a key an object of them. */
  private resolveFor(node: ForNode, state: State, context: Context | undefined, reading: Reading): Value {
    const items = forItems(this.collectionOf(node, state, context, reading), node.collection.position);
    const names = items.map((item) => withNames(reading, node, item));
    if (node.key) return this.resolveForObject(node, node.key, names, state, context);

    return tupleOf(names.map((itemNames) => this.resolveItem(node.body, state, context, itemNames)));
  }

  /** Every key and value is read before the object is made, so a mistake in any item is found while another's key is not known yet. */
  private resolveForObject(node: ForNode, key: AttributeValue, names: Reading[], state: State, context: Context | undefined): Value {
    const entries = names.map((itemNames): ForItem => [this.resolveItem(key, state, context, itemNames), this.resolveItem(node.body, state, context, itemNames)]);

    return forObject(entries, node.grouped === true, key.position);
  }

  /**
   * How many items a collection not known yet has is not known either, nor the order of a set with a member not known yet, so the for is left to the apply.
   * A collection not known yet whose type the for cannot go over is refused now, as a known one is.
   */
  private collectionOf(node: ForNode, state: State, context: Context | undefined, reading: Reading): Value {
    let collection: Value;
    try {
      collection = this.resolveIn(node.collection, state, context, reading);
    } catch (error) {
      if (!(error instanceof UnresolvedReferenceError)) throw error;
      checkCollection(valueOf(error.type, UNKNOWN), node.collection.position);
      this.readBodyOnce(node, valueOf(error.type, UNKNOWN), state, context, reading);
      // A for gives a tuple or an object, whatever type its collection has.
      throw new UnresolvedReferenceError(error.message);
    }

    if (unordered(collection)) {
      this.readBodyOnce(node, collection, state, context, reading);
      throw new UnresolvedReferenceError('The set a for goes over has a member known only after apply, so it has no order yet');
    }
    return collection;
  }

  /** Read as written, the body is read once for an item not known yet, so a mistake in it is found before the collection is known. */
  private readBodyOnce(node: ForNode, collection: Value, state: State, context: Context | undefined, reading: Reading): void {
    if (!reading.asWritten) return;

    const names = withNames(reading, node, unknownItem(collection.type));
    if (node.key) this.resolveItem(node.key, state, context, names);
    this.resolveItem(node.body, state, context, names);
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

  /** A data source is read at load and a directory is the module's, so both are known as written; anything else is not known yet. */
  private writtenTarget(reference: ParsedReference, where: Context, position: Position): { value: Value; path: Step[] } {
    // Neither reads the state.
    if (reference.kind === 'data' || reference.kind === 'path') return this.resolveTarget(reference, emptyState(), where, position);

    const { type, path } = this.written.typeOf(reference, where, position);
    return { value: valueOf(type, UNKNOWN), path };
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

  resolveValue(node: AttributeValue, state: State, context?: Context): Value {
    return this.resolveIn(node, state, context, READING);
  }

  /** A value as written, each reference in it not known yet, of the type it will have; read once, it holds what any instance of its block would read. */
  readAsWritten(node: AttributeValue, context: Context): Value {
    // Read as written, nothing reads the state.
    return this.resolveItem(node, emptyState(), context, { ...READING, asWritten: true });
  }

  /** A literal list is a tuple and a literal map an object, each item with the type it has. */
  private resolveIn(node: AttributeValue, state: State, context: Context | undefined, reading: Reading): Value {
    if (node.type === 'Reference') return this.resolve(node, state, context, reading);
    if (node.type === 'Bound') return this.resolveBound(node, reading.given);
    if (node.type === 'Call') return this.resolveCall(node, state, context, reading);
    if (node.type === 'For') return this.resolveFor(node, state, context, reading);
    if (node.type === 'Template') return this.resolveTemplate(node.value, state, context, reading);
    if (node.type === 'List') return this.resolveList(node.value, state, context, reading);
    if (node.type === 'Map') return this.resolveMap(node.value, state, context, reading);

    return literal(node);
  }

  private resolveList(items: AttributeValue[], state: State, context: Context | undefined, reading: Reading): Value {
    return tupleOf(items.map((item) => this.resolveItem(item, state, context, reading)));
  }

  private resolveMap(entries: Record<string, AttributeValue>, state: State, context: Context | undefined, reading: Reading): Value {
    return objectOf(Object.entries(entries).map(([key, item]) => [key, this.resolveItem(item, state, context, reading)]));
  }

  /** At plan time an item only an apply can read is UNKNOWN on its own, of the type it will have, so the list or map around it keeps what is known. */
  private resolveItem(value: AttributeValue, state: State, context: Context | undefined, reading: Reading): Value {
    try {
      return this.resolveIn(value, state, context, reading);
    } catch (error) {
      if (!(error instanceof UnresolvedReferenceError && (reading.asWritten || this.planned.isPlanning()))) throw error;
      return valueOf(error.type, UNKNOWN);
    }
  }

  /** A template that is one interpolation is the value itself, type and all; text around it makes it a string, which is not known while a part is not. */
  private resolveTemplate(parts: TemplatePart[], state: State, context: Context | undefined, reading: Reading): Value {
    const [first] = parts;
    if (parts.length === 1 && typeof first !== 'string') return this.resolveIn(first, state, context, reading);

    // Every part is read, so a mistake after one not known yet is still found.
    const unresolved: UnresolvedReferenceError[] = [];
    const texts = parts.map((part) => (typeof part === 'string' ? part : this.textOf(part, state, context, reading, unresolved)));
    if (unresolved.length > 0) throw new UnresolvedReferenceError(unresolved[0].message, types.string);

    return valueOf(types.string, texts.join(''));
  }

  /** The part's text, or none while it is not known yet, which is kept in `unresolved`. */
  private textOf(part: ReferenceNode | CallNode | BoundNode, state: State, context: Context | undefined, reading: Reading, unresolved: UnresolvedReferenceError[]): string {
    try {
      return this.joined(part, state, context, reading);
    } catch (error) {
      if (!(error instanceof UnresolvedReferenceError)) throw error;
      unresolved.push(error);
      return '';
    }
  }

  /** Only a string, a number or a boolean has a text to join. */
  private joined(part: ReferenceNode | CallNode | BoundNode, state: State, context: Context | undefined, reading: Reading): string {
    const resolved = this.resolveIn(part, state, context, reading);
    if (resolved.data === null || !hasText(resolved.type)) throw new ConfigError(`${spellNamed(part)} is ${described(resolved)} and cannot be joined into a string`, part.position);

    return String(resolved.data);
  }
}
