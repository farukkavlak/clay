import {
  Address,
  AttributePath,
  containsUnknown,
  ExactNumber,
  InstanceKey,
  isInstanceKey,
  isOutput,
  isModulePath,
  isRecord,
  isType,
  isUnknown,
  ModuleAddress,
  ModuleStep,
  NumberError,
  Output,
  own,
  readResources,
  Resource,
  Schema,
  State,
  Type,
  typeAt,
  typeIn,
  UNKNOWN,
  unknownPaths,
  valueAt,
} from '@clay/contracts';
import { AttributeValue, ResourceBlock } from '@clay/parser';
import { isDeepStrictEqual } from 'node:util';

export type ActionType = 'CREATE' | 'UPDATE' | 'REPLACE' | 'DELETE' | 'NO_OP';

/** A resource from the config: where it lives, the block as parsed, its values with references resolved and held to its schema, and what its provider plans it to hold. */
export interface DesiredResource {
  address: Address;
  block: ResourceBlock;
  attributes: Record<string, unknown>;
  /** Every value it will hold once applied, as its provider plans it; UNKNOWN where only the apply makes one. */
  after: Record<string, unknown>;
  /** The provider plans to replace it rather than change it in place. */
  replace: boolean;
  dependencies: string[];
  /** Where state held it before count came or went; the state planned against already has it here. */
  movedFrom?: string;
}

/** What each named value was and would become; a missing `old` is an addition, a missing `new` a removal. */
export type Changes = Record<string, { old: unknown; new: unknown }>;

/** What each root output was and would become, each side with its type. */
export type OutputChanges = Record<string, { old: Output | undefined; new: Output | undefined }>;

export interface PlanAction {
  type: ActionType;
  resourceType: string;
  name: string;
  modulePath?: readonly ModuleStep[];
  key?: InstanceKey;
  /** The address state holds the resource under, when count was added or taken off since: it moves before the action runs. */
  movedFrom?: string;
  attributes?: Record<string, AttributeValue>;
  /** Every value a create, an update or a replace was planned with, some not known yet. The apply resolves the attributes again and holds each known one to this. */
  planned?: Record<string, unknown>;
  /** What the resource will hold once applied, as its provider planned it. */
  after?: Record<string, unknown>;
  changes?: Changes;
  dependencies?: string[];
}

/** The actions to take, how the root outputs would change, and the serial of the state it was planned against. */
export interface Plan {
  serial: number;
  actions: PlanAction[];
  outputs: OutputChanges;
  /** The resources as state held them when the plan was made. */
  prevRun: Record<string, Resource>;
  /** The same resources as their providers read them then, which the actions run against; one not found is left out. */
  prior: Record<string, Resource>;
  /** The schema of each resource type the plan holds, so a saved plan says which value is a set without a provider. */
  schemas: Record<string, Schema>;
}

/** Bumped when the shape below changes once a Clay is released, so a plan file from an older version is refused instead of misread. */
export const PLAN_FILE_VERSION = '17.0';

export interface PlanFile extends Plan {
  version: string;
  timestamp: string;
  /** The configuration the plan was made from. A saved plan runs against it, not against whatever is on disk later. */
  config: string;
  /** The module files it read, by path relative to the root configuration. */
  modules: Record<string, string>;
}

function withoutUnknown(value: unknown): unknown {
  if (isUnknown(value)) return null;
  if (Array.isArray(value)) return value.map((item) => withoutUnknown(item));

  return isRecord(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withoutUnknown(item)])) : value;
}

/**
 * A value not known yet has no form in JSON, so a saved change holds null in its place and lists where each one is beside `new`.
 * A list of steps cannot be mistaken for anything the value holds, as a marker inside it could.
 */
function saveChange(change: { old: unknown; new: unknown }): Record<string, unknown> {
  const paths = unknownPaths(change.new);
  if (paths.length === 0) return change;
  if (isUnknown(change.new)) return { old: change.old, unknown: paths };

  return { old: change.old, new: withoutUnknown(change.new), unknown: paths };
}

function saveChanges(changes: Changes): Record<string, unknown> {
  return Object.fromEntries(Object.entries(changes).map(([name, change]) => [name, saveChange(change)]));
}

/** Planned values are saved as changes from nothing, so a value not known yet is saved the one way. */
function saveValues(values: Record<string, unknown>): Record<string, unknown> {
  return saveChanges(Object.fromEntries(Object.entries(values).map(([name, value]) => [name, { old: undefined, new: value }])));
}

function saveAction(action: PlanAction): Record<string, unknown> {
  return {
    ...action,
    ...(action.changes && { changes: saveChanges(action.changes) }),
    ...(action.planned && { planned: saveValues(action.planned) }),
    ...(action.after && { after: saveValues(action.after) }),
  };
}

/** Whether the steps land on something in the value, so a saved unknown has a place to go back into. */
function lands(value: unknown, path: AttributePath): boolean {
  if (path.length === 0) return true;

  const [step, ...rest] = path;
  if (Array.isArray(value)) return typeof step === 'number' && Number.isInteger(step) && step >= 0 && step < value.length && lands(value[step], rest);

  return isRecord(value) && typeof step === 'string' && Object.hasOwn(value, step) && lands(value[step], rest);
}

function placeUnknown(value: unknown, path: AttributePath): unknown {
  if (path.length === 0) return UNKNOWN;

  const [step, ...rest] = path;
  const container = value as Record<string | number, unknown>;
  container[step] = placeUnknown(container[step], rest);
  return value;
}

function readChanges<T>(saved: Record<string, { old?: T; new?: T; unknown?: AttributePath[] }>): Record<string, { old: T | undefined; new: T | undefined }> {
  return Object.fromEntries(
    Object.entries(saved).map(([name, change]) => [
      name,
      { old: change.old, new: (change.unknown ?? []).reduce<unknown>((value, path) => placeUnknown(value, path), change.new) as T },
    ])
  );
}

/** The plan file's text, as `plan --out` writes it and `parsePlanFile` reads it. */
export function serializePlan(plan: Plan, configContent: string, modules: Record<string, string>): string {
  const file = {
    version: PLAN_FILE_VERSION,
    timestamp: new Date().toISOString(),
    config: configContent,
    modules,
    serial: plan.serial,
    actions: plan.actions.map((action) => saveAction(action)),
    outputs: saveChanges(plan.outputs),
    prevRun: plan.prevRun,
    prior: plan.prior,
    schemas: plan.schemas,
  };

  return JSON.stringify(file, undefined, 2);
}

function isPath(path: unknown): path is AttributePath {
  return Array.isArray(path) && path.every((step) => typeof step === 'string' || typeof step === 'number');
}

/** One path that leads through another would put a value into what is not known yet. */
function overlaps(paths: AttributePath[]): boolean {
  return paths.some((path, i) => paths.some((other, j) => i !== j && path.length <= other.length && path.every((step, k) => other[k] === step)));
}

/** Where a saved change says a value is not known, there has to be a place in it to put one back, and only one. */
function isUnknownPaths(change: Record<string, unknown>): boolean {
  const { unknown } = change;
  if (unknown === undefined) return true;

  return Array.isArray(unknown) && unknown.every((path) => isPath(path) && lands(change.new, path)) && !overlaps(unknown as AttributePath[]);
}

/** Each change is read for what it held, so one that is not a record would fail far from the file it came from. */
function isChanges(changes: unknown): boolean {
  return isRecord(changes) && Object.values(changes).every((change) => isRecord(change) && isUnknownPaths(change));
}

/** A side of an output change that is there holds a value with its type, and only the value may be not known yet. */
function isOutputChange(change: unknown): boolean {
  if (!isRecord(change)) return false;

  const inValue = !Array.isArray(change.unknown) || change.unknown.every((path) => Array.isArray(path) && path[0] === 'value');
  return inValue && [change.old, change.new].every((side) => side === undefined || isOutput(side));
}

function isOutputChanges(changes: unknown): boolean {
  return isChanges(changes) && Object.values(changes as Record<string, unknown>).every((change) => isOutputChange(change));
}

function isModuleFiles(modules: unknown): modules is Record<string, string> {
  return isRecord(modules) && Object.values(modules).every((content) => typeof content === 'string');
}

/** A move starts where count coming or going left the action's own resource, and nowhere else. */
function isMovedFrom(action: Record<string, unknown>): boolean {
  if (action.movedFrom === undefined) return true;
  if (typeof action.resourceType !== 'string' || typeof action.name !== 'string') return false;

  const module = new ModuleAddress((action.modulePath as readonly ModuleStep[] | undefined) ?? []);
  const address = new Address(module, action.resourceType, action.name, action.key as InstanceKey | undefined);
  return address.countCounterparts().some((kept) => kept.toString() === action.movedFrom);
}

/** The actions that send values to a provider, and so are planned with them and planned by it. */
const SENDS_VALUES = new Set<ActionType>(['CREATE', 'UPDATE', 'REPLACE']);

/** A create, an update or a replace carries the values it was planned with and what its provider planned; any other action carries neither. */
function carriesValues(action: Record<string, unknown>): boolean {
  const sends = SENDS_VALUES.has(action.type as ActionType);

  return [action.planned, action.after].every((values) => (values === undefined ? !sends : sends && isChanges(values)));
}

function isAction(action: unknown): boolean {
  return (
    isRecord(action) &&
    (action.modulePath === undefined || isModulePath(action.modulePath)) &&
    (action.key === undefined || isInstanceKey(action.key)) &&
    isMovedFrom(action) &&
    (action.changes === undefined || isChanges(action.changes)) &&
    carriesValues(action)
  );
}

const FLAGS = ['required', 'forceNew', 'computed', 'optional', 'kept'] as const;

function isSchema(schema: unknown): schema is Schema {
  return (
    isRecord(schema) &&
    Object.values(schema).every(
      (definition) => isRecord(definition) && isType(definition.type) && FLAGS.every((flag) => definition[flag] === undefined || typeof definition[flag] === 'boolean')
    )
  );
}

function isSchemas(schemas: unknown): schemas is Record<string, Schema> {
  return isRecord(schemas) && Object.values(schemas).every((schema) => isSchema(schema));
}

/** What a plan holds, apart from the file around it and the resources it carries, which are read as state's are. */
function isPlan(plan: Partial<Plan>): plan is Plan {
  return (
    typeof plan.serial === 'number' && Array.isArray(plan.actions) && plan.actions.every((action) => isAction(action)) && isOutputChanges(plan.outputs) && isSchemas(plan.schemas)
  );
}

export function validatePlanFile(planFile: unknown): planFile is PlanFile {
  if (!planFile || typeof planFile !== 'object') return false;

  const pf = planFile as Partial<PlanFile>;
  return pf.version === PLAN_FILE_VERSION && typeof pf.timestamp === 'string' && typeof pf.config === 'string' && isModuleFiles(pf.modules) && isPlan(pf);
}

/** A plan file is written by `plan`, never by hand, so the only answer to a broken one is to plan again: the reason it is broken would not help. */
function planVersion(parsed: unknown): string | undefined {
  if (!isRecord(parsed) || !Array.isArray(parsed.actions)) return undefined;

  return typeof parsed.version === 'string' ? parsed.version : undefined;
}

/** A position says where a value was written and is no value itself, so its line and column read back as JavaScript numbers. */
function readPosition(position: unknown): void {
  if (!isRecord(position)) return;

  for (const field of ['line', 'column']) if (position[field] instanceof ExactNumber) position[field] = position[field].toSafeInteger(`a position's ${field}`);
}

function childrenOf(node: Record<string, unknown>): unknown[] {
  if ((node.type === 'List' || node.type === 'Template') && Array.isArray(node.value)) return node.value;
  if (node.type === 'Map' && isRecord(node.value)) return Object.values(node.value);

  return [];
}

/** An index is a place in a list, not a value, so it reads back as a JavaScript number too. */
function readIndexes(node: Record<string, unknown>): void {
  if (node.type === 'Reference' && Array.isArray(node.value)) node.value = node.value.map((step: unknown) => (step instanceof ExactNumber ? step.toSafeInteger('an index') : step));
}

function readNode(node: unknown): void {
  if (!isRecord(node)) return;

  readPosition(node.position);
  readIndexes(node);
  for (const child of childrenOf(node)) readNode(child);
}

/** An index in the steps to a value not known yet is a place in a list, so it reads back as a JavaScript number. */
function readSteps(path: unknown): unknown {
  if (!Array.isArray(path)) return path;

  return path.map((step: unknown) => (step instanceof ExactNumber ? step.toSafeInteger('an index') : step));
}

function readUnknownPaths(changes: unknown): void {
  if (!isRecord(changes)) return;

  for (const change of Object.values(changes)) if (isRecord(change) && Array.isArray(change.unknown)) change.unknown = change.unknown.map((path: unknown) => readSteps(path));
}

function readAction(action: Record<string, unknown>): void {
  if (action.key instanceof ExactNumber) action.key = action.key.toSafeInteger('an instance key');
  readUnknownPaths(action.changes);
  readUnknownPaths(action.planned);
  readUnknownPaths(action.after);
  if (Array.isArray(action.modulePath))
    for (const step of action.modulePath) if (isRecord(step) && step.key instanceof ExactNumber) step.key = step.key.toSafeInteger('a module key');
  if (isRecord(action.attributes)) for (const node of Object.values(action.attributes)) readNode(node);
}

/** The plan's serial, the keys of its actions, the positions and indexes in its parsed attributes, and the indexes to values not known yet, are the file's own numbers; every other number in it is a value, kept exactly. */
function readPlan(content: string): unknown {
  const read = ExactNumber.readJSON(content);
  if (!isRecord(read)) return read;

  if (read.serial instanceof ExactNumber) read.serial = read.serial.toSafeInteger('its serial');
  if (Array.isArray(read.actions)) for (const action of read.actions) if (isRecord(action)) readAction(action);
  readUnknownPaths(read.outputs);

  return read;
}

/** Values saved as changes from nothing, read back as the values. */
function readValues(saved: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(readChanges(saved as Record<string, { new?: unknown; unknown?: AttributePath[] }>)).map(([name, change]) => [name, change.new]));
}

function readSavedAction(action: PlanAction): PlanAction {
  return {
    ...action,
    ...(action.changes && { changes: readChanges(action.changes) }),
    ...(action.planned && { planned: readValues(action.planned) }),
    ...(action.after && { after: readValues(action.after) }),
  };
}

/** A plan that holds a resource without its type's schema could not show which of its values are sets. */
function checkSchemasCover(plan: Plan, say: (problem: string) => never): void {
  const types = [...plan.actions, ...Object.values(plan.prevRun), ...Object.values(plan.prior)].map((held) => held.resourceType);
  const missing = types.find((type) => !Object.hasOwn(plan.schemas, type));
  if (missing !== undefined) say(`it has no schema for ${missing}`);
}

/** `source` names the plan in the error, since the caller knows where it read from and this does not. */
export function parsePlanFile(content: string, source: string): PlanFile {
  let parsed: unknown;

  try {
    parsed = readPlan(content);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${source} is not a plan file: the file is not JSON`, { cause: error });

    if (error instanceof NumberError) throw new Error(`${source} is not a plan file: ${error.message}`, { cause: error });

    throw error;
  }

  const version = planVersion(parsed);
  if (version !== undefined && version !== PLAN_FILE_VERSION) throw new Error(`${source} was written by another Clay, plan version ${version}`);
  if (!validatePlanFile(parsed)) throw new Error(`${source} is not a plan file`);

  const say = (problem: string): never => {
    throw new Error(`${source} is not a plan file: ${problem}`);
  };
  readResources(parsed.prevRun, 'its prevRun resources', say);
  readResources(parsed.prior, 'its prior resources', say);
  checkSchemasCover(parsed, say);

  return {
    ...parsed,
    actions: parsed.actions.map((action) => readSavedAction(action)),
    outputs: readChanges(parsed.outputs),
  };
}

/** A map's keys written in another order is not a change. */
function valueChanged(oldValue: unknown, newValue: unknown): boolean {
  if (isUnknown(newValue)) return true;
  return !isDeepStrictEqual(oldValue, newValue);
}

/** Maps throughout: a name every object answers to would otherwise be read from the side that never set it, and `__proto__` would set a prototype instead of a key. */
function calculateDiff<T>(oldAttrs: Record<string, T>, newAttrs: Record<string, T>): Record<string, { old: T | undefined; new: T | undefined }> | null {
  const before = new Map(Object.entries(oldAttrs));
  const after = new Map(Object.entries(newAttrs));
  const changes = new Map<string, { old: T | undefined; new: T | undefined }>();

  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const oldValue = before.get(key);
    const newValue = after.get(key);

    if (valueChanged(oldValue, newValue)) changes.set(key, { old: oldValue, new: newValue });
  }

  return changes.size > 0 ? Object.fromEntries(changes) : null;
}

/** An output changes when its value does or its type does: the same members as a set and as a list are two values. */
export function outputChanges(current: Record<string, Output>, desired: Record<string, Output>): OutputChanges {
  return calculateDiff(current, desired) ?? {};
}

/** A resource changed outside Clay: gone, when it has no changes, or read with values other than state held. */
export interface Drift {
  address: string;
  changes?: Changes;
}

/** What the refresh found that the last run did not leave, from the two states the plan carries. */
export function changedOutside(plan: Plan): Drift[] {
  return Object.entries(plan.prevRun).flatMap(([address, held]) => {
    if (!Object.hasOwn(plan.prior, address)) return [{ address }];

    const changes = calculateDiff(held.attributes, plan.prior[address].attributes);
    return changes ? [{ address, changes }] : [];
  });
}

/** A place a value comes to something other than the plan showed there, and the two values at that place. */
export interface Mismatch {
  path: AttributePath;
  planned: unknown;
  returned: unknown;
}

function includes(members: unknown[], member: unknown): boolean {
  return members.some((other) => isDeepStrictEqual(other, member));
}

/**
 * A set's members have no place, so it holds to the plan when it has every member the plan knew, and no more others than the plan had members not
 * known yet: each of those may come to a member of its own, or to one the set already has.
 */
function setMismatches(planned: unknown[], actual: unknown, at: AttributePath): Mismatch[] {
  if (!Array.isArray(actual)) return [{ path: at, planned, returned: actual }];

  const known = planned.filter((member) => !containsUnknown(member));
  const others = actual.filter((member) => !includes(known, member));
  const holds = known.every((member) => includes(actual, member)) && others.length <= planned.length - known.length;

  return holds ? [] : [{ path: at, planned, returned: actual }];
}

type Compare = (type: Type, planned: unknown, actual: unknown, at: AttributePath) => Mismatch[];

function itemMismatches(type: Type, planned: unknown[], actual: unknown, at: AttributePath, compare: Compare): Mismatch[] {
  if (!Array.isArray(actual) || planned.length !== actual.length) return [{ path: at, planned, returned: actual }];

  return planned.flatMap((item, i) => compare(typeAt(type, i), item, actual[i], [...at, i]));
}

function entryMismatches(type: Type, planned: Record<string, unknown>, actual: unknown, at: AttributePath, compare: Compare): Mismatch[] {
  if (!isRecord(actual) || !isDeepStrictEqual(Object.keys(planned).sort(), Object.keys(actual).sort())) return [{ path: at, planned, returned: actual }];

  return Object.keys(planned).flatMap((key) => compare(typeAt(type, key), planned[key], actual[key], [...at, key]));
}

/** A value the plan did not know yet may come to anything; a known one, and every known part of one known in part, comes to the same. */
function mismatches(type: Type, planned: unknown, actual: unknown, at: AttributePath): Mismatch[] {
  if (isUnknown(planned)) return [];
  if (type.kind === 'set' && Array.isArray(planned)) return setMismatches(planned, actual, at);
  if (Array.isArray(planned)) return itemMismatches(type, planned, actual, at, mismatches);
  if (isRecord(planned)) return entryMismatches(type, planned, actual, at, mismatches);

  return isDeepStrictEqual(planned, actual) ? [] : [{ path: at, planned, returned: actual }];
}

/** Every place the plan made again at apply differs from what the plan showed. A value the plan did not know may come to anything, or stay not known. */
export function offFinal(schema: Schema, after: Record<string, unknown>, final: Record<string, unknown>): Mismatch[] {
  return [...new Set([...Object.keys(after), ...Object.keys(final)])].flatMap((name) => mismatches(typeIn(schema, name), own(after, name), own(final, name), [name]));
}

/**
 * Every place what an apply returned differs from what the plan showed. A value the configuration sets is held to what it resolved to for the apply, which the
 * plan may not have known. Nothing returned may be unknown, since an apply returns the resource as it is.
 */
export function offApply(schema: Schema, after: Record<string, unknown>, inputs: Record<string, unknown>, returned: Record<string, unknown>): Mismatch[] {
  const expected = { ...after, ...inputs };

  return [...new Set([...Object.keys(expected), ...Object.keys(returned)])].flatMap((name) => {
    const unknown = unknownPaths(own(returned, name), [name]);
    if (unknown.length > 0) return unknown.map((path) => ({ path, planned: valueAt(expected, path), returned: UNKNOWN }));

    return mismatches(typeIn(schema, name), own(expected, name), own(returned, name), [name]);
  });
}

/** The first value a resource now resolves to that the plan showed otherwise, or nothing when every one holds to the plan. */
export function offPlan(schema: Schema, planned: Record<string, unknown>, resolved: Record<string, unknown>): { name: string; planned: unknown; resolved: unknown } | undefined {
  for (const name of new Set([...Object.keys(planned), ...Object.keys(resolved)]))
    if (mismatches(typeIn(schema, name), own(planned, name), own(resolved, name), [name]).length > 0) return { name, planned: own(planned, name), resolved: own(resolved, name) };

  return undefined;
}

/** Tells whether a resource in state would change, without building the action for it. */
export function hasChanges(currentAttrs: Record<string, unknown>, after: Record<string, unknown>): boolean {
  return calculateDiff(currentAttrs, after) !== null;
}

function processExistingResource(actions: PlanAction[], desired: DesiredResource, currentResource: Resource) {
  const moved = desired.movedFrom;
  const resource = desired.block;
  const changes = calculateDiff(currentResource.attributes, desired.after);

  if (!changes && !desired.replace) {
    actions.push({
      type: 'NO_OP',
      ...desired.address.fields(),
      ...(moved && { movedFrom: moved }),
      dependencies: desired.dependencies,
    });
    return;
  }

  actions.push({
    type: desired.replace ? 'REPLACE' : 'UPDATE',
    ...desired.address.fields(),
    ...(moved && { movedFrom: moved }),
    attributes: resource.attributes,
    planned: desired.attributes,
    after: desired.after,
    changes: changes ?? {},
    dependencies: desired.dependencies,
  });
}

/** `currentState` is the state with every move already made, as the desired resources were planned against it. */
export function plan(desiredResources: DesiredResource[], currentState: State): PlanAction[] {
  const actions: PlanAction[] = [];
  const currentMap = new Map<string, Resource>(Object.entries(currentState.resources));
  const desiredMap = new Map<string, DesiredResource>();

  for (const desired of desiredResources) desiredMap.set(desired.address.toString(), desired);

  for (const [key, desired] of desiredMap.entries()) {
    const currentResource = currentMap.get(key);
    if (currentResource) processExistingResource(actions, desired, currentResource);
    else
      actions.push({
        type: 'CREATE',
        ...desired.address.fields(),
        attributes: desired.block.attributes,
        planned: desired.attributes,
        after: desired.after,
        dependencies: desired.dependencies,
      });
  }

  for (const [key, resource] of currentMap.entries()) {
    if (desiredMap.has(key)) continue;

    actions.push({
      type: 'DELETE',
      ...Address.of(resource).fields(),
    });
  }

  return actions;
}
