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
  State,
  typeNestingOf,
  types,
  UNKNOWN,
} from '@clay/contracts';
import {
  AttributeValue,
  BoundNode,
  CallNode,
  ConfigError,
  EachReference,
  IndexNode,
  LocalReference,
  ParsedReference,
  PathReference,
  parseReference,
  Position,
  ReferenceNode,
  spell,
  spellIndex,
  spellNamed,
  spellReference,
  Step,
  stepKey,
  VariableReference,
} from '@clay/parser';

import { Instances } from '../instances/Instances';
import { functionCalled } from './functions';
import { Context, DataInstance, instanceKeyOf, ModuleCall, moduleOf, scopeOf } from '../keys';
import { tryAt } from '../place';
import { ModuleInstances } from '../instances/ModuleInstances';
import { checkBoolean } from './operators';
import { Planned } from '../values/Planned';
import { Versions } from '../values/Versions';
import { ScopeManager } from '../config/ScopeManager';
import { mayBeSensitive, objectOf, sensitiveOf, tupleOf, Value, valueOf, wholeIf, withSensitive } from '../values/Value';
import { isSensitive, itemsOf, marksOfWhole, sharedMarks, Whole, wholeOf, wholeWhere } from '../values/sensitive';
import { DataSourceResolver } from './references/DataSourceResolver';
import { checkUnknownIndex, keyOf } from './indexKey';
import { COUNT_INDEX_OUTSIDE, eachOutside } from './references/instance';
import { InstanceKeys } from './references/InstanceKeys';
import { ModuleOutputResolver } from './references/ModuleOutputResolver';
import { unknownOf, UnresolvedReferenceError } from './UnresolvedReferenceError';
import { readPath } from './readPath';
import { ResourceResolver } from './references/ResourceResolver';
import { VariableResolver } from './references/VariableResolver';
import { Source, WrittenTypes } from './references/WrittenTypes';
import { Evaluator, Reading, READING } from './Evaluator';
import { ForResolver } from './ForResolver';
import { isOperation, OperationResolver } from './OperationResolver';
import { TemplateResolver } from './TemplateResolver';

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

function countIndex(where: Context, position: Position): Value {
  const key = instanceKeyOf(where);
  if (typeof key !== 'number') throw new ConfigError(COUNT_INDEX_OUTSIDE, position);

  return valueOf(types.number, ExactNumber.parse(String(key)));
}

type Named = ReferenceNode | IndexNode | BoundNode;

function unknownAs(value: Value): Value {
  return withSensitive(valueOf(value.type, UNKNOWN), wholeOf(value));
}

/** In a read by type, a value read by its value is not known either. */
function typeOnly(value: Value, reading: Reading): Value {
  return reading.byType ? unknownAs(value) : value;
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
  /** Whether an index is sensitive, and whether one may be. */
  whole: Whole;
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
  return `${spellIndex(node)} was read at a sensitive index, so why it failed is not shown`;
}

/** The marks under `keys`. */
function marksAlong(paths: AttributePath[], keys: (string | number)[]): AttributePath[] {
  return keys.reduce((marks, key) => sensitiveUnder(marks, key), paths);
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
  private fors: ForResolver;
  private operations: OperationResolver;
  private templates: TemplateResolver;
  /** Read once however many read it, by its value as parsed, which one load makes and no other shares. */
  private writtenLocals = new WeakMap<AttributeValue, Value>();
  /** As held by an instance, by its value as parsed, the same way. */
  private writtenValues = new WeakMap<AttributeValue, Value>();

  constructor(
    scopeManager: ScopeManager,
    dataSources: Map<string, Record<string, Value>>,
    schemas: Map<string, Schema>,
    dataSchemas: Map<string, Schema>,
    instances: Instances,
    modules: ModuleInstances,
    planned: Planned,
    private keys: InstanceKeys,
    versions: Versions
  ) {
    this.scopeManager = scopeManager;
    this.instances = instances;
    this.planned = planned;
    this.modules = modules;
    this.variables = new VariableResolver(scopeManager, this);
    this.dataSources = new DataSourceResolver(dataSources, dataSchemas, instances);
    this.moduleOutputs = new ModuleOutputResolver(scopeManager, modules);
    this.resources = new ResourceResolver(instances, planned, schemas, versions);
    this.written = new WrittenTypes(scopeManager, schemas, dataSchemas, instances, modules);
    // Bound, not wrapped, so a nested read costs no extra stack frame.
    const evaluator: Evaluator = {
      resolveIn: this.resolveIn.bind(this),
      resolveItem: this.resolveItem.bind(this),
      boolean: this.boolean.bind(this),
      byType: this.byType.bind(this),
    };
    this.fors = new ForResolver(evaluator, planned);
    this.operations = new OperationResolver(evaluator);
    this.templates = new TemplateResolver(evaluator);
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

    return readPath(result, spellNamed(node), [], node.position);
  }

  /** A value not known yet is read into by its type, so a step it cannot have is refused at plan. */
  private resolveIndex(node: IndexNode, state: State, context: Context | undefined, reading: Reading): Value {
    const value = this.indexOf(node.value, { node, state, context, reading });
    const read: Reader = (steps) => readPath(value, spellIndex(node.value), steps, node.position);

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

    const { sensitive, maybe } = keyed.whole;
    return wholeWhere(
      hidingIf(sensitive, atSensitiveIndex(site.node), site.node.position, () => read(keyed.steps)),
      sensitive,
      maybe
    );
  }

  /** The steps before the first index not known yet, with a key for each index read from a value, and the keys after it. */
  private keyed(steps: Step[], site: Site): Keyed {
    const keyed: Keyed = { steps: [], whole: { sensitive: false, maybe: false }, rest: [] };

    for (const step of steps) {
      const { key, index } = this.keyOfStep(step, site);
      if (index) keyed.whole = { sensitive: keyed.whole.sensitive || isSensitive(index), maybe: keyed.whole.maybe || mayBeSensitive(index) };
      if (keyed.later) keyed.rest.push(key === undefined ? EVERY_ITEM : stepKey(key));
      else if (key === undefined) keyed.later = step;
      else keyed.steps.push(key);
    }

    return keyed;
  }

  /** A step as it reads, with the key an index comes to and the index read; no key for an index not known yet. */
  private keyOfStep(step: Step, site: Site): { key?: Step; index?: Value } {
    if (!('index' in step)) return { key: step };

    const index = this.indexOf(step.index, site);
    if (!isUnknown(index.data)) return { key: keyOf(index, step), index };

    checkUnknownIndex(index, step);
    return { index };
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
  private readLater(node: Named, { steps, whole, rest }: Keyed, read: Reader): never {
    let items: Value[];

    try {
      items = itemsOf(hidingIf(whole.sensitive, atSensitiveIndex(node), node.position, () => read(steps)));
    } catch (error) {
      if (!(error instanceof UnresolvedReferenceError)) throw error;
      items = itemsOf(unknownOf(error));
    }

    throw new UnresolvedReferenceError(`${spellIndex(node)} is known only after apply`, types.dynamic, marksOfWhole(whole, marksAlong(sharedMarks(items), rest)));
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

  /** Paths are known at load, and a local is read as written in its turn; anything else is unknown, with the marks its declaration gives every instance. */
  private writtenTarget(reference: ParsedReference, where: Context, position: Position): { value: Value; path: Step[] } {
    if (reference.kind === 'path') return this.resolveTarget(reference, emptyState(), where, position, READING);
    if (reference.kind === 'local') return { value: this.writtenLocal(reference, where), path: reference.path };

    const { type, sensitive, from, path } = this.written.typeOf(reference, where, position);
    return { value: withSensitive(valueOf(type, UNKNOWN), [...sensitive, ...from.flatMap((source) => this.marksFrom(source))]), path };
  }

  /** Placed at the value, as a local is. */
  private marksFrom({ value, context, declaration, held, at }: Source): AttributePath[] {
    const readNode = (node: AttributeValue) => this.readAsWritten(node, context);
    const read = this.writtenValues.get(value) ?? tryAt(value.position, declaration, context, () => held(readNode(value), readNode));

    this.writtenValues.set(value, read);
    return sensitiveOf(read).map((path) => [...at, ...path]);
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
    if (node.type === 'Index') return this.resolveIndex(node, state, context, reading);
    if (node.type === 'For') return this.fors.resolveFor(node, state, context, reading);
    if (node.type === 'Template') return this.templates.resolveTemplate(node.value, state, context, reading);
    if (node.type === 'List') return this.resolveList(node.value, state, context, reading);
    if (node.type === 'Map') return this.resolveMap(node.value, state, context, reading);
    if (isOperation(node)) return this.operations.resolveOperation(node, state, context, reading);

    return literal(node);
  }

  private boolean(node: AttributeValue, who: string, state: State, context: Context | undefined, reading: Reading): Value {
    const value = this.resolveItem(node, state, context, reading);
    checkBoolean(who, value, node.position);

    return value;
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
}
