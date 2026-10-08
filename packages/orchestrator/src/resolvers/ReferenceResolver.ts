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
  stepKey,
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

/** `null` gets no type yet. */
function literal(node: Extract<AttributeValue, { type: 'String' | 'Number' | 'Boolean' | 'Null' }>): Value {
  return node.type === 'Null' ? valueOf(types.dynamic, null) : valueOf(LITERALS[node.type], node.value);
}

/** Values bound by enclosing for expressions. */
type Given = ReadonlyMap<string, Value>;

/** With `asWritten`, every reference reads as unknown of the type it will have. */
interface Reading {
  given: Given;
  asWritten: boolean;
}

const READING: Reading = { given: new Map(), asWritten: false };

function withNames(reading: Reading, node: ForNode, [key, value]: ForItem): Reading {
  const names = new Map(reading.given).set(node.valueName, value);

  return { ...reading, given: node.keyName === undefined ? names : names.set(node.keyName, key) };
}

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
    dataSchemas: Map<string, Schema>,
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
    this.written = new WrittenTypes(scopeManager, schemas, dataSchemas, instances, modules);
  }

  private resolve(node: ReferenceNode, state: State, context: Context | undefined, reading: Reading): Value {
    const reference = parseReference(node.value);
    const where = context ?? ModuleAddress.root;
    const { value, path } = reading.asWritten ? this.writtenTarget(reference, where, node.position) : this.resolveTarget(reference, state, where, node.position);
    const target = node.value.slice(0, node.value.length - path.length);

    return readPath(value, spellReference(target), path, node.position);
  }

  /** Looks up the function first, so an unknown name is refused whatever the argument is. */
  private resolveCall(node: CallNode, state: State, context: Context | undefined, reading: Reading): Value {
    const result = functionCalled(node)(this.resolveItem(node.args[0], state, context, reading));

    return readPath(result, spellNamed({ ...node, path: [] }), node.path, node.position);
  }

  /** The parser only binds a name inside its for, so it always has a value here. */
  private resolveBound(node: BoundNode, given: Given): Value {
    const [first, ...path] = node.value;
    const name = String(stepKey(first));

    return readPath(given.get(name)!, name, path, node.position);
  }

  private resolveFor(node: ForNode, state: State, context: Context | undefined, reading: Reading): Value {
    const items = forItems(this.collectionOf(node, state, context, reading), node.collection.position);
    const names = items.map((item) => withNames(reading, node, item));
    if (node.key) return this.resolveForObject(node, node.key, names, state, context);

    return tupleOf(names.map((itemNames) => this.resolveItem(node.body, state, context, itemNames)));
  }

  /** Resolves every key and value first, so an error in any item is found even when another key is unknown. */
  private resolveForObject(node: ForNode, key: AttributeValue, names: Reading[], state: State, context: Context | undefined): Value {
    const entries = names.map((itemNames): ForItem => [this.resolveItem(key, state, context, itemNames), this.resolveItem(node.body, state, context, itemNames)]);

    return forObject(entries, node.grouped === true, key.position);
  }

  /**
   * An unknown collection, or a set with an unknown member, has no known items or order, so the for waits for apply.
   * Its type is still checked now.
   */
  private collectionOf(node: ForNode, state: State, context: Context | undefined, reading: Reading): Value {
    let collection: Value;
    try {
      collection = this.resolveIn(node.collection, state, context, reading);
    } catch (error) {
      if (!(error instanceof UnresolvedReferenceError)) throw error;
      checkCollection(valueOf(error.type, UNKNOWN), node.collection.position);
      this.readBodyOnce(node, valueOf(error.type, UNKNOWN), state, context, reading);
      // Rethrown without the collection's type: a for makes a tuple or an object whatever it iterates.
      throw new UnresolvedReferenceError(error.message);
    }

    if (unordered(collection)) {
      this.readBodyOnce(node, collection, state, context, reading);
      throw new UnresolvedReferenceError('The set a for goes over has a member known only after apply, so it has no order yet');
    }
    return collection;
  }

  /** In `asWritten` mode, resolves the body once with an unknown item, so its errors are found before the collection is known. */
  private readBodyOnce(node: ForNode, collection: Value, state: State, context: Context | undefined, reading: Reading): void {
    if (!reading.asWritten) return;

    const names = withNames(reading, node, unknownItem(collection.type));
    if (node.key) this.resolveItem(node.key, state, context, names);
    this.resolveItem(node.body, state, context, names);
  }

  private resolveTarget(reference: ParsedReference, state: State, where: Context, position: Position): { value: Value; path: Step[] } {
    if (reference.kind === 'variable') return { value: this.variables.resolve(reference, where, state), path: reference.path };
    if (reference.kind === 'data') return { value: this.dataSources.resolve(reference, where), path: reference.path };
    if (reference.kind === 'module') return this.moduleOutputs.resolve(reference, where, position);
    if (reference.kind === 'count') return { value: countIndex(where, position), path: reference.path };
    if (reference.kind === 'each') return { value: this.each(reference, where, position), path: reference.path };
    if (reference.kind === 'path') return { value: valueOf(types.string, this.directory(reference, where)), path: reference.path };

    return this.resources.resolve(reference, where, state, position);
  }

  /** Paths are known at load; anything else is unknown. */
  private writtenTarget(reference: ParsedReference, where: Context, position: Position): { value: Value; path: Step[] } {
    if (reference.kind === 'path') return this.resolveTarget(reference, emptyState(), where, position);

    const { type, path } = this.written.typeOf(reference, where, position);
    return { value: valueOf(type, UNKNOWN), path };
  }

  private each(reference: EachReference, where: Context, position: Position): Value {
    const key = instanceKeyOf(where);
    if (typeof key !== 'string') throw new ConfigError(eachOutside(reference.name), position);
    if (reference.name === 'key') return valueOf(types.string, key);

    // Only a resource instance or a module call has a key, and its for_each is read before anything in the instance.
    const value = where instanceof ModuleCall ? this.modules.eachValue(where.call, key) : this.instances.eachValue((where as Address).withoutKey().toString(), key);
    if (value === undefined) throw new Error(`each.value of "${key}" was read before its for_each`);

    return value;
  }

  /** Relative to the root, so a state or a plan reads the same on another machine. */
  private directory(reference: PathReference, where: Context): string {
    if (reference.name === 'root') return '.';

    // Every called module is loaded, with its directory, before anything in it is read.
    return this.scopeManager.getDirectory(scopeOf(moduleOf(where).withoutKeys()))!;
  }

  resolveAttributes(attributes: Record<string, AttributeValue>, state: State, context?: Context): Record<string, Value> {
    return Object.fromEntries(Object.entries(attributes).map(([name, value]) => [name, this.resolveValue(value, state, context)]));
  }

  resolveValue(node: AttributeValue, state: State, context?: Context): Value {
    return this.resolveIn(node, state, context, READING);
  }

  /** Every reference reads as unknown of the type it will have, so one read covers every instance of the block. */
  readAsWritten(node: AttributeValue, context: Context): Value {
    // Nothing reads the state here.
    return this.resolveItem(node, emptyState(), context, { ...READING, asWritten: true });
  }

  /** A literal list is a tuple and a literal map an object. */
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

  /** At plan time an item only the apply knows becomes UNKNOWN by itself, so the rest of its list or map stays known. */
  private resolveItem(value: AttributeValue, state: State, context: Context | undefined, reading: Reading): Value {
    try {
      return this.resolveIn(value, state, context, reading);
    } catch (error) {
      if (!(error instanceof UnresolvedReferenceError && (reading.asWritten || this.planned.isPlanning()))) throw error;
      return valueOf(error.type, UNKNOWN);
    }
  }

  /** A lone interpolation keeps its value and type; with any text it becomes a string, unknown if any part is. */
  private resolveTemplate(parts: TemplatePart[], state: State, context: Context | undefined, reading: Reading): Value {
    const [first] = parts;
    if (parts.length === 1 && typeof first !== 'string') return this.resolveIn(first, state, context, reading);

    // Every part is resolved, so an error after an unknown part is still found.
    const unresolved: UnresolvedReferenceError[] = [];
    const texts = parts.map((part) => (typeof part === 'string' ? part : this.textOf(part, state, context, reading, unresolved)));
    if (unresolved.length > 0) throw new UnresolvedReferenceError(unresolved[0].message, types.string);

    return valueOf(types.string, texts.join(''));
  }

  /** Collects an unknown part into `unresolved`. */
  private textOf(part: ReferenceNode | CallNode | BoundNode, state: State, context: Context | undefined, reading: Reading, unresolved: UnresolvedReferenceError[]): string {
    try {
      return this.joined(part, state, context, reading);
    } catch (error) {
      if (!(error instanceof UnresolvedReferenceError)) throw error;
      unresolved.push(error);
      return '';
    }
  }

  /** Only a string, a number or a boolean can be joined. */
  private joined(part: ReferenceNode | CallNode | BoundNode, state: State, context: Context | undefined, reading: Reading): string {
    const resolved = this.resolveIn(part, state, context, reading);
    if (resolved.data === null || !hasText(resolved.type)) throw new ConfigError(`${spellNamed(part)} is ${described(resolved)} and cannot be joined into a string`, part.position);

    return String(resolved.data);
  }
}
