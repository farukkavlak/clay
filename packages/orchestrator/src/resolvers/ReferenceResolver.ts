import {
  Address,
  AttributePath,
  emptyState,
  EVERY_ITEM,
  ExactNumber,
  isUnknown,
  MAX_NESTING,
  ModuleAddress,
  Schema,
  sensitiveUnder,
  SOMEWHERE,
  State,
  Type,
  typeNestingOf,
  types,
  UNKNOWN,
} from '@clay/contracts';
import {
  AttributeValue,
  BinaryNode,
  BoundNode,
  CallNode,
  ConditionalNode,
  ConfigError,
  EachReference,
  ForNode,
  isNamed,
  LocalReference,
  NegateNode,
  NotNode,
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
  VariableReference,
} from '@clay/parser';

import { converted } from '../conformValues';
import {
  certainItem,
  certainSteps,
  checkCollection,
  checkKey,
  forItems,
  ForItem,
  forObject,
  laterObjectMarks,
  laterTupleMarks,
  refuseDuplicateKeys,
  under,
  unknownItem,
} from '../forItems';
import { Instances } from '../Instances';
import { functionCalled } from '../functions';
import { Context, DataInstance, instanceKeyOf, ModuleCall, moduleOf, scopeOf } from '../keys';
import { tryAt } from '../place';
import { ModuleInstances } from '../ModuleInstances';
import { Arithmetic, arithmetic, asNumber, checkBoolean, equality, isOrdering, negated, negative, NumberValue, Ordering, ordering } from '../operators';
import { Planned } from '../Planned';
import { ScopeManager } from '../scope/ScopeManager';
import { unified, Unjoinable, unjoined } from '../unify';
import {
  allSensitiveIf,
  article,
  described,
  fewest,
  hasText,
  isAllSensitive,
  isSensitive,
  itemsOf,
  objectOf,
  sensitiveSomewhere,
  sharedMarks,
  tupleOf,
  unordered,
  Value,
  valueOf,
  withSensitive,
  wholeIf,
} from '../Value';
import { DataSourceResolver } from './DataSourceResolver';
import { checkUnknownIndex, keyOf } from './indexKey';
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

/** Through references a value grows deeper than any written, until a walk over it overflows the stack. Its type is at least as deep as its data. */
function withinNesting(node: AttributeValue, value: Value): Value {
  if (typeNestingOf(value.type) > MAX_NESTING) throw new ConfigError(`Nested more than ${MAX_NESTING} levels deep`, node.position);

  return value;
}

/** Values bound by enclosing for expressions. */
type Given = ReadonlyMap<string, Value>;

/**
 * With `asWritten`, a reference reads as unknown of the type it will have, and a local as its value read the same way.
 * With `byType` too, a local and a call's result read as unknown as well, so nothing is read for its value.
 */
interface Reading {
  given: Given;
  asWritten: boolean;
  byType?: true;
  /** A variable's value, already worked out, so its own rules read it without reading it again. */
  variable?: { name: string; value: Value };
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

type Operation = BinaryNode | NotNode | NegateNode | ConditionalNode;

function isOperation(node: AttributeValue): node is Operation {
  return node.type === 'Binary' || node.type === 'Not' || node.type === 'Negate' || node.type === 'Conditional';
}

function unknownAs(value: Value): Value {
  return withSensitive(valueOf(value.type, UNKNOWN), wholeIf(isSensitive(value)));
}

/** In a read by type, a value read by its value is not known either. */
function typeOnly(value: Value, reading: Reading): Value {
  return reading.byType ? unknownAs(value) : value;
}

const FOR_IF = 'The if of a for';

/** The items an if may keep; `later` where its value for one is not known yet. */
interface Picked {
  items: Reading[];
  /** For each item, whether the if keeps it whatever the apply finds. */
  kept: boolean[];
  sensitive: boolean;
  later: boolean;
}

interface ReadItem {
  key?: Value;
  body: Value;
  condition?: Value;
}

/** Read with an item that stands for every one, and again with each item the collection holds for certain. */
interface ReadOnce extends Partial<ReadItem> {
  certain: (ReadItem & { step: string | number })[];
  /** How many of `certain` come first, in the order the for goes over them. */
  leading: number;
  /** An item the collection holds for certain, though not which: any member of a set with one not known yet, or the one where a collection sensitive somewhere is. */
  held?: ReadItem;
}

/** The node being read, and what its indexes are read with. */
interface Site {
  node: Named;
  state: State;
  context: Context | undefined;
  reading: Reading;
}

type Reader = (steps: Step[]) => Value;

/** `later` is the first index whose value is not known yet, and `steps` stop before it. */
interface Keyed {
  steps: Step[];
  sensitive: boolean;
  later?: Step;
  /** The key of each step after `later`; every item where another index is not known yet. */
  rest: (string | number)[];
}

/** Only that the read failed is told, since why may say what the sensitive value is. */
function hidingIf(sensitive: boolean, message: string, position: Position, read: () => Value): Value {
  if (!sensitive) return read();

  try {
    return read();
  } catch (error) {
    if (error instanceof ConfigError) throw new ConfigError(message, position);
    if (error instanceof UnresolvedReferenceError) throw new UnresolvedReferenceError(message, error.type, wholeIf(true));
    throw error;
  }
}

/** What went wrong reading at a sensitive index may quote the index. */
function atSensitiveIndex(node: Named): string {
  return `${spellNamed(node)} was read at a sensitive index, so why it failed is not shown`;
}

/** The marks under `keys`. */
function marksAlong(paths: AttributePath[], keys: (string | number)[]): AttributePath[] {
  return keys.reduce((marks, key) => sensitiveUnder(marks, key), paths);
}

/**
 * Each item has what the body has for every item; one the collection holds for certain keeps its marks at its key, or, with no if, at its place.
 * The first `leading` of `certain` come first in the order the for goes over them, so one kept for certain before any that may be dropped
 * keeps its place, in a group too. Any other item comes after them.
 */
function laterForMarks(node: ForNode, every: ReadItem, certain: (ReadItem & { step: string | number })[], leading: number): AttributePath[] {
  const items = [...certain.slice(0, leading), every, ...certain.slice(leading)];
  const kept = items.map((item) => item !== every && (item.condition === undefined || item.condition.data === true));
  if (node.key)
    return laterObjectMarks(
      items.map((item): ForItem => [item.key ?? valueOf(types.dynamic, UNKNOWN), item.body]),
      kept,
      node.grouped === true
    );

  const places = node.condition ? [] : certain.flatMap((item) => (typeof item.step === 'number' ? under(item.step, item.body.sensitive ?? []) : []));
  return fewest([
    ...laterTupleMarks(
      items.map((item) => item.body),
      kept
    ),
    ...places,
  ]);
}

const keptForCertain = (item: ReadItem) => item.condition === undefined || item.condition.data === true;

/** An item held for certain decides the size where its if is sensitive, and the keys where it is kept and its key is sensitive. */
function heldDecides(held: ReadItem | undefined): boolean {
  if (held === undefined) return false;

  return (held.condition !== undefined && isSensitive(held.condition)) || (keptForCertain(held) && held.key !== undefined && isSensitive(held.key));
}

/** An item held for certain, not known which, makes the for sensitive somewhere where it is kept and its body is sensitive for certain. */
const heldSensitive = (held: ReadItem | undefined) => held !== undefined && keptForCertain(held) && isSensitive(held.body);

/** Neither side decides `&&` or `||` yet. One not known may still decide alone, so a mark on the other is the answer's only where both have it. */
function undecidedMarks(left: Value, right: Value): AttributePath[] {
  const [leftMarked, rightMarked] = [isSensitive(left), isSensitive(right)];

  return wholeIf((leftMarked && !isUnknown(right.data)) || (rightMarked && !isUnknown(left.data)) || (leftMarked && rightMarked));
}

/** The results in the order written: when true, then when false. */
function resultType(node: ConditionalNode, [whenTrue, whenFalse]: Value[]): Type {
  try {
    return unified([whenTrue.type, whenFalse.type]);
  } catch (error) {
    if (!(error instanceof Unjoinable)) throw error;
    throw new ConfigError(`The two results of a conditional ${unjoined(error, isSensitive(whenTrue) || isSensitive(whenFalse))}`, node.whenTrue.position);
  }
}

/** The picked value takes the type both results join into, which a value of no type until read may still not fit. */
function fitted(taken: AttributeValue, value: Value, written: Type): Value {
  try {
    return converted('A conditional', value, unified([written, value.type]), []);
  } catch (error) {
    if (!(error instanceof Unjoinable)) throw error;
    throw new ConfigError(`The result a condition picks ${unjoined(error, isSensitive(value))}`, taken.position);
  }
}

/** A value with no name is found by where it is written. */
function spelledPart(part: AttributeValue): string {
  return isNamed(part) ? spellNamed(part) : "The value inside '${'";
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
    const read: Reader = (steps) => this.readReference(steps, node, state, where, reading);

    return this.readWith({ node, state, context, reading }, node.value, read);
  }

  /**
   * A key the block's count or for_each does not make is refused where it is read, since an instance not made yet would read as unknown, not
   * missing. A read by type alone checks none, so the result a condition does not pick may name an instance that is not there.
   */
  private readReference(steps: Step[], node: ReferenceNode, state: State, where: Context, reading: Reading): Value {
    const { position } = node;
    const reference = parseReference(steps);
    if (!reading.asWritten) this.keys.of(reference, where, position);
    const { value, path } = reading.asWritten ? this.writtenTarget(reference, where, position) : this.resolveTarget(reference, state, where, position, reading);
    const target = steps.slice(0, steps.length - path.length);

    const read = readPath(typeOnly(value, reading), spellReference(target), path, position);

    // As written, since an index read from a value may be a sensitive key.
    return read.data === null ? { ...read, nullFrom: spellNamed(node) } : read;
  }

  /** Looks up the function first, so an unknown name is refused whatever the arguments are. */
  private resolveCall(node: CallNode, state: State, context: Context | undefined, reading: Reading): Value {
    const called = functionCalled(node);
    const result = typeOnly(called(node.args.map((arg) => this.resolveItem(arg, state, context, reading))), reading);
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
   * An index not known yet makes the result unknown, with the marks every item has along the steps after it, or whole where an index is sensitive.
   */
  private readWith(site: Site, steps: Step[], read: Reader): Value {
    if (!steps.some((step) => 'index' in step)) return read(steps);

    const keyed = this.keyed(steps, site);
    if (keyed.later) return this.readLater(site.node, keyed, read);

    return allSensitiveIf(
      keyed.sensitive,
      hidingIf(keyed.sensitive, atSensitiveIndex(site.node), site.node.position, () => read(keyed.steps))
    );
  }

  /** The steps before the first index not known yet, with a key for each index read from a value, and the keys after it. */
  private keyed(steps: Step[], site: Site): Keyed {
    const keyed: Keyed = { steps: [], sensitive: false, rest: [] };

    for (const step of steps) {
      const { key, sensitive } = this.keyOfStep(step, site);
      keyed.sensitive = keyed.sensitive || sensitive;
      if (keyed.later) keyed.rest.push(key === undefined ? EVERY_ITEM : stepKey(key));
      else if (key === undefined) keyed.later = step;
      else keyed.steps.push(key);
    }

    return keyed;
  }

  /** A step as it reads, with the key an index comes to; none for an index not known yet. */
  private keyOfStep(step: Step, site: Site): { key?: Step; sensitive: boolean } {
    if (!('index' in step)) return { key: step, sensitive: false };

    const index = this.indexOf(step.index, site);
    if (!isUnknown(index.data)) return { key: keyOf(index, step), sensitive: isSensitive(index) };

    checkUnknownIndex(index, step);
    return { sensitive: isSensitive(index) };
  }

  private indexOf(node: AttributeValue, { state, context, reading }: Site): Value {
    try {
      return this.resolveIn(node, state, context, reading);
    } catch (error) {
      if (!(error instanceof UnresolvedReferenceError)) throw error;
      return unknownOf(error);
    }
  }

  /** The type the rest would find is not known without the index, so the unknown has none. Whichever item it reads, it has what every item has. */
  private readLater(node: Named, { steps, sensitive: indexSensitive, rest }: Keyed, read: Reader): never {
    let items: Value[];

    try {
      items = itemsOf(hidingIf(indexSensitive, atSensitiveIndex(node), node.position, () => read(steps)));
    } catch (error) {
      if (!(error instanceof UnresolvedReferenceError)) throw error;
      items = itemsOf(unknownOf(error));
    }

    throw new UnresolvedReferenceError(`${spellNamed(node)} is known only after apply`, types.dynamic, indexSensitive ? [[]] : marksAlong(sharedMarks(items), rest));
  }

  /** Over a collection sensitive as a whole, or with a sensitive if, what it gives is too: how many items it keeps tells the if. */
  private resolveFor(node: ForNode, state: State, context: Context | undefined, reading: Reading): Value {
    const collection = this.collectionOf(node, state, context, reading);
    const names = forItems(collection, node.collection.position).map((item) => withNames(reading, node, item));
    const picked = this.picked(node, names, state, context);
    const sensitive = isAllSensitive(collection) || picked.sensitive;
    if (picked.later) throw this.laterPicked(node, picked, sensitive, state, context);

    const made = node.key
      ? this.resolveForObject(node, node.key, picked.items, sensitive, state, context)
      : tupleOf(picked.items.map((itemNames) => this.resolveItem(node.body, state, context, itemNames)));

    return allSensitiveIf(sensitive, made);
  }

  /** The items the if may keep. One it leaves out is read by type only, so `x.name if x != null` reads `.name` only where there is an x. */
  private picked(node: ForNode, names: Reading[], state: State, context: Context | undefined): Picked {
    const { condition } = node;
    if (!condition) return { items: names, kept: names.map(() => true), sensitive: false, later: false };

    const ifs = names.map((itemNames) => this.boolean(condition, FOR_IF, state, context, itemNames));
    for (const [index, itemNames] of names.entries()) if (ifs[index].data === false) this.readItemByType(node, itemNames, context);

    const maybe = ifs.filter((value) => value.data !== false);
    return {
      items: names.filter((_, index) => ifs[index].data !== false),
      kept: maybe.map((value) => value.data === true),
      sensitive: ifs.some((value) => isSensitive(value)),
      later: ifs.some((value) => isUnknown(value.data)),
    };
  }

  private readItemByType(node: ForNode, itemNames: Reading, context: Context | undefined): void {
    if (node.key) checkKey(this.byType(node.key, context, itemNames), node.key.position);
    this.byType(node.body, context, itemNames);
  }

  /**
   * Which items an if keeps waits for the apply, but two it keeps for certain are there whatever the apply finds, so a key both give is refused now.
   * Every item it may keep is read now, so a mistake in any is found.
   * Only marks every outcome has are kept: a sensitive key of an item kept for certain makes it sensitive as a whole.
   */
  private laterPicked(node: ForNode, { items, kept }: Picked, sensitive: boolean, state: State, context: Context | undefined): UnresolvedReferenceError {
    const { key } = node;
    const keys = key ? items.map((itemNames) => this.checkedKey(key, state, context, itemNames)) : [];
    const bodies = items.map((itemNames) => this.resolveItem(node.body, state, context, itemNames));
    if (key && !node.grouped)
      refuseDuplicateKeys(
        keys.filter((_, index) => kept[index]),
        key.position
      );

    const message = 'The if of a for is known only after apply for an item, so what the for gives is not known yet';
    if (sensitive || keys.some((found, index) => kept[index] && isSensitive(found))) return new UnresolvedReferenceError(message, types.dynamic, wholeIf(true));

    const marks = key
      ? laterObjectMarks(
          keys.map((found, index): ForItem => [found, bodies[index]]),
          kept,
          node.grouped === true
        )
      : laterTupleMarks(bodies, kept);
    return new UnresolvedReferenceError(message, types.dynamic, marks);
  }

  private checkedKey(key: AttributeValue, state: State, context: Context | undefined, itemNames: Reading): Value {
    const found = this.resolveItem(key, state, context, itemNames);
    checkKey(found, key.position);
    return found;
  }

  /** Resolves every key and value first, so an error in any item is found even when another key is unknown. */
  private resolveForObject(node: ForNode, key: AttributeValue, items: Reading[], sensitive: boolean, state: State, context: Context | undefined): Value {
    const entries = items.map((itemNames): ForItem => [this.resolveItem(key, state, context, itemNames), this.resolveItem(node.body, state, context, itemNames)]);

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

    // A condition or an operator gives a value not known yet where a reference would throw.
    if (isUnknown(collection.data)) {
      checkCollection(collection, node.collection.position);
      throw this.laterFor(node, collection, 'What a for goes over is known only after apply', state, context, reading);
    }
    if (unordered(collection))
      throw this.laterFor(node, collection, 'The set a for goes over has a member known only after apply, so it has no order yet', state, context, reading);
    return collection;
  }

  /**
   * Its size and keys are the collection's, the key's and the if's, so it is sensitive as a whole where any is, or where an item it keeps for certain
   * has a sensitive key. It has no type: a for makes a tuple or an object whatever it iterates.
   */
  private laterFor(node: ForNode, collection: Value, message: string, state: State, context: Context | undefined, reading: Reading): UnresolvedReferenceError {
    const { key, body, condition, certain, leading, held } = this.readOnce(node, collection, state, context, reading);
    const kept = certain.filter((item) => keptForCertain(item));
    if (node.key && !node.grouped)
      refuseDuplicateKeys(
        kept.flatMap((item) => (item.key === undefined ? [] : [item.key])),
        node.key.position
      );
    const decided = [...certain, held].some((item) => heldDecides(item));
    const whole = [key, condition].some((part) => part !== undefined && isSensitive(part)) || isAllSensitive(collection) || decided;
    if (whole) return new UnresolvedReferenceError(message, types.dynamic, wholeIf(true));

    // Read without a body outside the plan, where no mark is shown, so each item is marked where any of the collection is for certain.
    if (body === undefined) return new UnresolvedReferenceError(message, types.dynamic, isSensitive(collection) ? [[EVERY_ITEM]] : []);

    const marks = laterForMarks(node, { key, body }, certain, leading);
    return new UnresolvedReferenceError(message, types.dynamic, heldSensitive(held) ? fewest([...marks, [SOMEWHERE]]) : marks);
  }

  /**
   * The key, the body and the if with an unknown item, so an error or a sensitive value in them is found before the collection is known,
   * with each item the collection holds for certain, and with the one it holds though not which.
   */
  private readOnce(node: ForNode, collection: Value, state: State, context: Context | undefined, reading: Reading): ReadOnce {
    if (!(reading.asWritten || this.planned.isPlanning())) return { certain: [], leading: 0 };

    const [itemKey, itemValue] = unknownItem(collection.type);
    const every = sensitiveUnder(collection.sensitive ?? [], EVERY_ITEM);
    const once = this.readItem(node, [itemKey, withSensitive(itemValue, every)], state, context, reading);
    const { steps, leading } = certainSteps(collection);
    const certain = steps.map((step) => ({ step, ...this.readItem(node, certainItem(collection, step), state, context, reading) }));

    return { ...once, certain, leading, held: this.heldItem(node, collection, once, state, context, reading) };
  }

  /** Read again with an item sensitive somewhere where the collection is; a set with a member not known yet holds one like any other. */
  private heldItem(node: ForNode, collection: Value, once: ReadItem, state: State, context: Context | undefined, reading: Reading): ReadItem | undefined {
    if (sensitiveSomewhere(collection)) {
      const [itemKey, itemValue] = unknownItem(collection.type);
      const marks = [...sensitiveUnder(collection.sensitive ?? [], EVERY_ITEM), [SOMEWHERE]];
      return this.readItem(node, [itemKey, withSensitive(itemValue, marks)], state, context, reading);
    }

    return Array.isArray(collection.data) && collection.data.length > 0 ? once : undefined;
  }

  private readItem(node: ForNode, item: ForItem, state: State, context: Context | undefined, reading: Reading): ReadItem {
    const names = withNames(reading, node, item);
    const key = node.key && this.resolveItem(node.key, state, context, names);
    const body = this.resolveItem(node.body, state, context, names);
    if (key && node.key) checkKey(key, node.key.position);
    const condition = node.condition && this.boolean(node.condition, FOR_IF, state, context, names);

    return { key, body, condition };
  }

  private resolveTarget(reference: ParsedReference, state: State, where: Context, position: Position, reading: Reading): { value: Value; path: Step[] } {
    if (reference.kind === 'variable') return { value: this.variable(reference, where, state, reading), path: reference.path };
    if (reference.kind === 'local') return { value: this.local(reference, where), path: reference.path };
    if (reference.kind === 'data') return this.dataSources.resolve(reference, where, position);
    if (reference.kind === 'module') return this.moduleOutputs.resolve(reference, where, position);
    if (reference.kind === 'count') return { value: countIndex(where, position), path: reference.path };
    if (reference.kind === 'each') return { value: this.each(reference, where, position), path: reference.path };
    if (reference.kind === 'path') return { value: valueOf(types.string, this.directory(reference, where)), path: reference.path };

    return this.resources.resolve(reference, where, state, position);
  }

  private variable(reference: VariableReference, where: Context, state: State, { variable }: Reading): Value {
    return variable?.name === reference.name ? variable.value : this.variables.resolve(reference, where, state);
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
    if (reference.kind === 'path') return this.resolveTarget(reference, emptyState(), where, position, READING);
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

  /** Reads `var.name` in a module instance, as a reference to it does. */
  resolveVariable(name: string, module: ModuleAddress, state: State): Value {
    return this.variables.resolve({ kind: 'variable', name, path: [] }, module, state);
  }

  /** Reads `var.name` as `value`, for a rule of that variable. */
  resolveWithVariable(node: AttributeValue, state: State, context: ModuleAddress, name: string, value: Value): Value {
    return this.resolveIn(node, state, context, { ...READING, variable: { name, value } });
  }

  /** A reference reads as unknown of the type it will have, and a local as its value read the same way, so one read covers every instance of the block. */
  readAsWritten(node: AttributeValue, context: Context): Value {
    // Nothing reads the state here.
    return withinNesting(node, this.resolveItem(node, emptyState(), context, { ...READING, asWritten: true }));
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
    if (isOperation(node)) return this.resolveOperation(node, state, context, reading);

    return literal(node);
  }

  private resolveOperation(node: Operation, state: State, context: Context | undefined, reading: Reading): Value {
    if (node.type === 'Not') return negated(this.boolean(node.value, '!', state, context, reading));
    if (node.type === 'Negate') return negative(this.number(node.value, '-', state, context, reading));
    if (node.type === 'Conditional') return this.resolveConditional(node, state, context, reading);
    if (node.operator === '&&' || node.operator === '||') return this.resolveLogic(node, node.operator, state, context, reading);
    if (node.operator === '==' || node.operator === '!=')
      return equality(node.operator, this.resolveItem(node.left, state, context, reading), this.resolveItem(node.right, state, context, reading), node.operatorPosition);

    return this.resolveNumbers(node, node.operator, state, context, reading);
  }

  private resolveNumbers(node: BinaryNode, operator: Arithmetic | Ordering, state: State, context: Context | undefined, reading: Reading): Value {
    const left = this.number(node.left, operator, state, context, reading);
    const right = this.number(node.right, operator, state, context, reading);

    return isOrdering(operator) ? ordering(operator, left, right, node.operatorPosition) : arithmetic(operator, left, right, node.operatorPosition);
  }

  private number(node: AttributeValue, who: string, state: State, context: Context | undefined, reading: Reading): NumberValue {
    return asNumber(who, this.resolveItem(node, state, context, reading), node.position);
  }

  private boolean(node: AttributeValue, who: string, state: State, context: Context | undefined, reading: Reading): Value {
    const value = this.resolveItem(node, state, context, reading);
    checkBoolean(who, value, node.position);

    return value;
  }

  /** A known left side that decides the answer leaves the right read by type only, so `var.x != null && var.x.on` reads `.on` only when there is an x. */
  private resolveLogic(node: BinaryNode, operator: '&&' | '||', state: State, context: Context | undefined, reading: Reading): Value {
    const deciding = operator === '||';
    const decided = (by: Value) => withSensitive(valueOf(types.bool, deciding), wholeIf(isSensitive(by)));

    const left = this.boolean(node.left, operator, state, context, reading);
    if (left.data === deciding) {
      checkBoolean(operator, this.byType(node.right, context, reading), node.right.position);
      return decided(left);
    }

    const right = this.boolean(node.right, operator, state, context, reading);
    const later = isUnknown(left.data);
    // With the left side not known yet, either side may decide, so a mark only one of them has waits for the apply.
    if (right.data === deciding) return !later || isSensitive(left) === isSensitive(right) ? decided(right) : valueOf(types.bool, UNKNOWN);

    const data = later || isUnknown(right.data) ? UNKNOWN : !deciding;
    return withSensitive(valueOf(types.bool, data), undecidedMarks(left, right));
  }

  /**
   * A known condition leaves the other result read by type only, so `var.x == null ? "none" : var.x.name` reads `.name` only when there is an x.
   * The type is what both results join into as written, so the condition changes it only where a value has no type until it is read.
   */
  private resolveConditional(node: ConditionalNode, state: State, context: Context | undefined, reading: Reading): Value {
    const condition = this.boolean(node.condition, 'A condition', state, context, reading);
    if (isUnknown(condition.data)) {
      const results = [node.whenTrue, node.whenFalse].map((result) => this.resolveItem(result, state, context, reading));
      // Only one result is the value, so it has the condition's mark and the marks both results have.
      return withSensitive(valueOf(resultType(node, results), UNKNOWN), isSensitive(condition) ? [[]] : sharedMarks(results));
    }

    const written = resultType(node, [this.byType(node.whenTrue, context, reading), this.byType(node.whenFalse, context, reading)]);
    const taken = condition.data === true ? node.whenTrue : node.whenFalse;
    const picked = fitted(taken, this.resolveItem(taken, state, context, reading), written);

    return allSensitiveIf(isSensitive(condition), picked);
  }

  /** Every name, local and call is unknown, so what fails only for the value it would be read with is not refused. */
  private byType(node: AttributeValue, context: Context | undefined, reading: Reading): Value {
    const given = new Map([...reading.given].map(([name, value]) => [name, unknownAs(value)]));

    return this.resolveItem(node, emptyState(), context, { given, asWritten: true, byType: true });
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
  private textOf(part: AttributeValue, state: State, context: Context | undefined, reading: Reading, unresolved: UnresolvedReferenceError[]): Value {
    try {
      const text = this.joined(part, state, context, reading);
      // A condition or an operator gives a value not known yet where a reference would throw.
      if (isUnknown(text.data)) unresolved.push(new UnresolvedReferenceError('A part of the string is known only after apply'));
      return text;
    } catch (error) {
      if (!(error instanceof UnresolvedReferenceError)) throw error;
      unresolved.push(error);
      return unknownOf(error);
    }
  }

  /** Only a string, a number or a boolean can be joined. */
  private joined(part: AttributeValue, state: State, context: Context | undefined, reading: Reading): Value {
    const resolved = this.resolvedPart(part, state, context, reading);
    if (resolved.data === null || !hasText(resolved.type)) throw this.unjoinable(part, described(resolved));

    return resolved;
  }

  /** A value not known yet is checked by the type it will have. */
  private resolvedPart(part: AttributeValue, state: State, context: Context | undefined, reading: Reading): Value {
    try {
      return this.resolveIn(part, state, context, reading);
    } catch (error) {
      if (!(error instanceof UnresolvedReferenceError) || hasText(error.type) || error.type.kind === 'dynamic') throw error;
      throw this.unjoinable(part, article(error.type.kind));
    }
  }

  private unjoinable(part: AttributeValue, what: string): ConfigError {
    return new ConfigError(`${spelledPart(part)} is ${what} and cannot be joined into a string`, part.position);
  }
}
