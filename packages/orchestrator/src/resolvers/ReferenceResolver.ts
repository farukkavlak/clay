import { Address, emptyState, EVERY_ITEM, ExactNumber, isUnknown, ModuleAddress, Schema, State, types, UNKNOWN } from '@clay/contracts';
import {
  AttributeValue,
  BoundNode,
  CallNode,
  ConfigError,
  EachReference,
  ForNode,
  IndexNode,
  LocalReference,
  ParsedReference,
  PathReference,
  parseReference,
  Position,
  ReferenceNode,
  spell,
  spellNamed,
  spellReference,
  Step,
  stepKey,
  TemplatePart,
} from '@clay/parser';

import { checkCollection, checkKey, forItems, ForItem, forObject, unknownItem } from '../forItems';
import { Instances } from '../Instances';
import { functionCalled } from '../functions';
import { Context, DataInstance, instanceKeyOf, ModuleCall, moduleOf, scopeOf } from '../keys';
import { tryAt } from '../place';
import { ModuleInstances } from '../ModuleInstances';
import { Planned } from '../Planned';
import { ScopeManager } from '../scope/ScopeManager';
import { allSensitive, allSensitiveIf, described, hasText, isAllSensitive, isSensitive, objectOf, tupleOf, unordered, Value, valueOf, withSensitive, wholeIf } from '../Value';
import { DataSourceResolver } from './DataSourceResolver';
import { keyOf } from './indexKey';
import { COUNT_INDEX_OUTSIDE, eachOutside } from './instance';
import { InstanceKeys } from './InstanceKeys';
import { ModuleOutputResolver } from './ModuleOutputResolver';
import { unknownOf, UnresolvedReferenceError } from './UnresolvedReferenceError';
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

/** With `asWritten`, a reference reads as unknown of the type it will have, and a local as its value read the same way. */
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

type Named = ReferenceNode | CallNode | BoundNode;

/** The node being read, and what its indexes are read with. */
interface Site {
  node: Named;
  state: State;
  context: Context | undefined;
  reading: Reading;
}

/** Reads the steps; `keyed` is whether an index read from a value gave one of them a key. */
type Reader = (steps: Step[], keyed: boolean) => Value;

/** `later` is the first index whose value is not known yet, and `steps` stop before it. */
interface Keyed {
  steps: Step[];
  sensitive: boolean;
  later?: Step;
}

/** What went wrong reading at a sensitive index may quote the index, so only that it did is told. */
function hidingIf(sensitive: boolean, node: Named, read: () => Value): Value {
  if (!sensitive) return read();

  const message = `${spellNamed(node)} was read at a sensitive index, so why it failed is not shown`;
  try {
    return read();
  } catch (error) {
    if (error instanceof ConfigError) throw new ConfigError(message, node.position);
    if (error instanceof UnresolvedReferenceError) throw new UnresolvedReferenceError(message, error.type, wholeIf(true));
    throw error;
  }
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
  /** Read once however many read it, by its value as parsed, which one load makes and no other shares. */
  private writtenLocals = new WeakMap<AttributeValue, Value>();

  constructor(
    scopeManager: ScopeManager,
    dataSources: Map<string, Record<string, Value>>,
    schemas: Map<string, Schema>,
    dataSchemas: Map<string, Schema>,
    instances: Instances,
    modules: ModuleInstances,
    planned: Planned,
    private keys: InstanceKeys
  ) {
    this.scopeManager = scopeManager;
    this.instances = instances;
    this.planned = planned;
    this.modules = modules;
    this.variables = new VariableResolver(scopeManager, this);
    this.dataSources = new DataSourceResolver(dataSources, dataSchemas, instances);
    this.moduleOutputs = new ModuleOutputResolver(scopeManager, modules);
    this.resources = new ResourceResolver(instances, planned, schemas);
    this.written = new WrittenTypes(scopeManager, schemas, dataSchemas, instances, modules);
  }

  private resolve(node: ReferenceNode, state: State, context: Context | undefined, reading: Reading): Value {
    const where = context ?? ModuleAddress.root;
    const read: Reader = (steps, keyed) => this.readReference(steps, node.position, state, where, reading, keyed);

    return this.readWith({ node, state, context, reading }, node.value, read);
  }

  /** `keyed` is whether an index read from a value gave a key, which the block's count or for_each may not make. */
  private readReference(steps: Step[], position: Position, state: State, where: Context, reading: Reading, keyed: boolean): Value {
    const reference = parseReference(steps);
    if (keyed) this.keys.of(reference, where, position);
    const { value, path } = reading.asWritten ? this.writtenTarget(reference, where, position) : this.resolveTarget(reference, state, where, position);
    const target = steps.slice(0, steps.length - path.length);

    return readPath(value, spellReference(target), path, position);
  }

  /** Looks up the function first, so an unknown name is refused whatever the argument is. */
  private resolveCall(node: CallNode, state: State, context: Context | undefined, reading: Reading): Value {
    const result = functionCalled(node)(this.resolveItem(node.args[0], state, context, reading));
    const read: Reader = (steps) => readPath(result, spellNamed({ ...node, path: [] }), steps, node.position);

    return this.readWith({ node, state, context, reading }, node.path, read);
  }

  /** The parser only binds a name inside its for, so it always has a value here. */
  private resolveBound(node: BoundNode, state: State, context: Context | undefined, reading: Reading): Value {
    const [first, ...path] = node.value;
    const name = String(stepKey(first));
    const read: Reader = (steps) => readPath(reading.given.get(name)!, name, steps, node.position);

    return this.readWith({ node, state, context, reading }, path, read);
  }

  /**
   * An index read from a value takes the key it comes to, and what it finds is sensitive when the index is.
   * An index not known yet makes the result unknown, sensitive when what it reads into or the index is.
   */
  private readWith(site: Site, steps: Step[], read: Reader): Value {
    if (!steps.some((step) => 'index' in step)) return read(steps, false);

    const keyed = this.keyed(steps, site);
    if (keyed.later) return this.readLater(site.node, keyed, read);

    return allSensitiveIf(
      keyed.sensitive,
      hidingIf(keyed.sensitive, site.node, () => read(keyed.steps, true))
    );
  }

  /** The steps before the first index not known yet, with a key for each index read from a value. */
  private keyed(steps: Step[], site: Site): Keyed {
    const found: Step[] = [];
    let sensitive = false;

    for (const step of steps) {
      if (!('index' in step)) {
        found.push(step);
        continue;
      }

      const index = this.indexOf(step.index, site);
      sensitive = sensitive || isSensitive(index);
      if (isUnknown(index.data)) return { steps: found, sensitive, later: step };

      found.push(keyOf(index, step.spelled, step.index.position));
    }

    return { steps: found, sensitive };
  }

  private indexOf(node: IndexNode, { state, context, reading }: Site): Value {
    try {
      return this.resolveIn(node, state, context, reading);
    } catch (error) {
      if (!(error instanceof UnresolvedReferenceError)) throw error;
      return unknownOf(error);
    }
  }

  /** The type the rest would find is not known without the index, so the unknown has none. */
  private readLater(node: Named, { steps, sensitive: indexSensitive }: Keyed, read: Reader): never {
    let sensitive = indexSensitive;

    try {
      sensitive = isSensitive(hidingIf(sensitive, node, () => read(steps, false))) || sensitive;
    } catch (error) {
      if (!(error instanceof UnresolvedReferenceError)) throw error;
      sensitive = error.sensitive.length > 0 || sensitive;
    }

    throw new UnresolvedReferenceError(`${spellNamed(node)} is known only after apply`, types.dynamic, wholeIf(sensitive));
  }

  /** Over a collection sensitive as a whole, what it gives is too: how many items it has is the collection's. */
  private resolveFor(node: ForNode, state: State, context: Context | undefined, reading: Reading): Value {
    const collection = this.collectionOf(node, state, context, reading);
    const names = forItems(collection, node.collection.position).map((item) => withNames(reading, node, item));
    const sensitive = isAllSensitive(collection);
    const made = node.key
      ? this.resolveForObject(node, node.key, names, sensitive, state, context)
      : tupleOf(names.map((itemNames) => this.resolveItem(node.body, state, context, itemNames)));

    return allSensitiveIf(sensitive, made);
  }

  /** Resolves every key and value first, so an error in any item is found even when another key is unknown. */
  private resolveForObject(node: ForNode, key: AttributeValue, names: Reading[], sensitive: boolean, state: State, context: Context | undefined): Value {
    const entries = names.map((itemNames): ForItem => [this.resolveItem(key, state, context, itemNames), this.resolveItem(node.body, state, context, itemNames)]);

    return forObject(entries, node.grouped === true, sensitive, key.position);
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
      const later = unknownOf(error);
      checkCollection(later, node.collection.position);
      throw this.laterFor(node, later, error.message, state, context, reading);
    }

    if (unordered(collection))
      throw this.laterFor(node, collection, 'The set a for goes over has a member known only after apply, so it has no order yet', state, context, reading);
    return collection;
  }

  /**
   * Its size and keys are the collection's and the key's, so it is sensitive as a whole where either is. Where only the body is, each item
   * is, and the body sees an item as sensitive as the collection's. It has no type: a for makes a tuple or an object whatever it iterates.
   */
  private laterFor(node: ForNode, collection: Value, message: string, state: State, context: Context | undefined, reading: Reading): UnresolvedReferenceError {
    const { key, body } = this.readOnce(node, collection, state, context, reading);
    const whole = isAllSensitive(collection) || (key !== undefined && isSensitive(key));
    const items = body === undefined ? isSensitive(collection) : isSensitive(body);

    if (whole) return new UnresolvedReferenceError(message, types.dynamic, wholeIf(true));

    return new UnresolvedReferenceError(message, types.dynamic, items ? [[EVERY_ITEM]] : []);
  }

  /** The key and the body with an unknown item, so an error or a sensitive value in them is found before the collection is known. */
  private readOnce(node: ForNode, collection: Value, state: State, context: Context | undefined, reading: Reading): { key?: Value; body?: Value } {
    if (!(reading.asWritten || this.planned.isPlanning())) return {};

    const [itemKey, itemValue] = unknownItem(collection.type);
    const names = withNames(reading, node, [itemKey, isSensitive(collection) ? allSensitive(itemValue) : itemValue]);
    const key = node.key && this.resolveItem(node.key, state, context, names);
    const body = this.resolveItem(node.body, state, context, names);
    if (key && node.key) checkKey(key, node.key.position);

    return { key, body };
  }

  private resolveTarget(reference: ParsedReference, state: State, where: Context, position: Position): { value: Value; path: Step[] } {
    if (reference.kind === 'variable') return { value: this.variables.resolve(reference, where, state), path: reference.path };
    if (reference.kind === 'local') return { value: this.local(reference, where), path: reference.path };
    if (reference.kind === 'data') return this.dataSources.resolve(reference, where, position);
    if (reference.kind === 'module') return this.moduleOutputs.resolve(reference, where, position);
    if (reference.kind === 'count') return { value: countIndex(where, position), path: reference.path };
    if (reference.kind === 'each') return { value: this.each(reference, where, position), path: reference.path };
    if (reference.kind === 'path') return { value: valueOf(types.string, this.directory(reference, where)), path: reference.path };

    return this.resources.resolve(reference, where, state, position);
  }

  /** The graph runs a local before anything that reads it, in every module instance. */
  private local(reference: LocalReference, where: Context): Value {
    const value = this.scopeManager.getLocal(scopeOf(where), reference.name);
    if (value === undefined) throw new Error(`local.${reference.name} was read before it was worked out`);

    return value;
  }

  /** Placed at the local, so a mistake in it is not reported at whatever reads it first. */
  private writtenLocal(reference: LocalReference, where: Context): Value {
    const module = moduleOf(where).withoutKeys();
    // The graph has already refused undeclared locals, and one that reads itself.
    const local = this.scopeManager.declaredLocal(scopeOf(module), reference.name)!;
    const read = this.writtenLocals.get(local.value) ?? tryAt(local.value.position, spell(local), module, () => this.readAsWritten(local.value, module));

    this.writtenLocals.set(local.value, read);
    return read;
  }

  /** Paths are known at load, and a local is read as written in its turn; anything else is unknown. */
  private writtenTarget(reference: ParsedReference, where: Context, position: Position): { value: Value; path: Step[] } {
    if (reference.kind === 'path') return this.resolveTarget(reference, emptyState(), where, position);
    if (reference.kind === 'local') return { value: this.writtenLocal(reference, where), path: reference.path };

    const { type, path } = this.written.typeOf(reference, where, position);
    return { value: valueOf(type, UNKNOWN), path };
  }

  private each(reference: EachReference, where: Context, position: Position): Value {
    const key = instanceKeyOf(where);
    if (typeof key !== 'string') throw new ConfigError(eachOutside(reference.name), position);
    if (reference.name === 'key') return valueOf(types.string, key);

    // Only a resource or data source instance or a module call has a key, and its for_each is read before anything in the instance.
    const value = this.eachValue(where, key);
    if (value === undefined) throw new Error(`each.value of "${key}" was read before its for_each`);

    return value;
  }

  private eachValue(where: Context, key: string): Value | undefined {
    if (where instanceof ModuleCall) return this.modules.eachValue(where.call, key);
    if (where instanceof DataInstance) return this.instances.eachValue(where.block, key);
    if (where instanceof Address) return this.instances.eachValue(where.withoutKey().toString(), key);

    return undefined;
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

  /** A reference reads as unknown of the type it will have, and a local as its value read the same way, so one read covers every instance of the block. */
  readAsWritten(node: AttributeValue, context: Context): Value {
    // Nothing reads the state here.
    return this.resolveItem(node, emptyState(), context, { ...READING, asWritten: true });
  }

  /** A literal list is a tuple and a literal map an object. */
  private resolveIn(node: AttributeValue, state: State, context: Context | undefined, reading: Reading): Value {
    if (node.type === 'Reference') return this.resolve(node, state, context, reading);
    if (node.type === 'Bound') return this.resolveBound(node, state, context, reading);
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
      return unknownOf(error);
    }
  }

  /** A lone interpolation keeps its value and type; with any text it becomes a string, unknown if any part is, and sensitive if any part is. */
  private resolveTemplate(parts: TemplatePart[], state: State, context: Context | undefined, reading: Reading): Value {
    const [first] = parts;
    if (parts.length === 1 && typeof first !== 'string') return this.resolveIn(first, state, context, reading);

    // Every part is resolved, so an error after an unknown part is still found.
    const unresolved: UnresolvedReferenceError[] = [];
    const texts = parts.map((part) => (typeof part === 'string' ? valueOf(types.string, part) : this.textOf(part, state, context, reading, unresolved)));
    const sensitive = wholeIf(texts.some((text) => isSensitive(text)));
    if (unresolved.length > 0) throw new UnresolvedReferenceError(unresolved[0].message, types.string, sensitive);

    return withSensitive(valueOf(types.string, texts.map((text) => String(text.data)).join('')), sensitive);
  }

  /** Collects an unknown part into `unresolved`. */
  private textOf(part: ReferenceNode | CallNode | BoundNode, state: State, context: Context | undefined, reading: Reading, unresolved: UnresolvedReferenceError[]): Value {
    try {
      return this.joined(part, state, context, reading);
    } catch (error) {
      if (!(error instanceof UnresolvedReferenceError)) throw error;
      unresolved.push(error);
      return unknownOf(error);
    }
  }

  /** Only a string, a number or a boolean can be joined. */
  private joined(part: ReferenceNode | CallNode | BoundNode, state: State, context: Context | undefined, reading: Reading): Value {
    const resolved = this.resolveIn(part, state, context, reading);
    if (resolved.data === null || !hasText(resolved.type)) throw new ConfigError(`${spellNamed(part)} is ${described(resolved)} and cannot be joined into a string`, part.position);

    return resolved;
  }
}
