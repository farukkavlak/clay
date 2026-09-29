import { Address, ExactNumber, InstanceKey, isInstanceKey, isModulePath, ModuleAddress, ModuleStep, NumberError, Resource, Schema, State } from '@clay/contracts';
import { AttributeValue, ResourceBlock } from '@clay/parser';
import { isDeepStrictEqual } from 'node:util';

export type ActionType = 'CREATE' | 'UPDATE' | 'REPLACE' | 'DELETE' | 'NO_OP';

/** Stands for a value that only exists once the resources it depends on are created. A symbol, so no value a configuration or a file holds can pass for it. */
export const UNKNOWN: unique symbol = Symbol('unknown');

export function isUnknown(value: unknown): boolean {
  return value === UNKNOWN;
}

/** A plain object, as JSON makes one: a number read from a file is an ExactNumber, which is no record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;

  const prototype: unknown = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}

/** Whether a value, or anything a list or a map in it holds, is not known yet: a plan may know a map and not one of its values. */
export function containsUnknown(value: unknown): boolean {
  if (isUnknown(value)) return true;
  if (Array.isArray(value)) return value.some((item) => containsUnknown(item));

  return isRecord(value) && Object.values(value).some((item) => containsUnknown(item));
}

/** A resource from the config: where it lives, the block as parsed, and its values with references resolved. */
export interface DesiredResource {
  address: Address;
  block: ResourceBlock;
  attributes: Record<string, unknown>;
  dependencies: string[];
  /** Where state held it before count came or went; the state planned against already has it here. */
  movedFrom?: string;
}

/** What each named value was and would become; a missing `old` is an addition, a missing `new` a removal. */
export type Changes = Record<string, { old: unknown; new: unknown }>;

export interface PlanAction {
  type: ActionType;
  resourceType: string;
  name: string;
  modulePath?: readonly ModuleStep[];
  key?: InstanceKey;
  /** The address state holds the resource under, when count was added or taken off since: it moves before the action runs. */
  movedFrom?: string;
  id?: string;
  attributes?: Record<string, AttributeValue>;
  changes?: Changes;
  dependencies?: string[];
}

/** The actions to take, how the root outputs would change, and the serial of the state it was planned against. */
export interface Plan {
  serial: number;
  actions: PlanAction[];
  outputs: Changes;
}

/** Bumped when the shape below changes once a Clay is released, so a plan file from an older version is refused instead of misread. */
export const PLAN_FILE_VERSION = '8.0';

export interface PlanFile extends Plan {
  version: string;
  timestamp: string;
  /** The configuration the plan was made from. A saved plan runs against it, not against whatever is on disk later. */
  config: string;
  /** The module files it read, by path relative to the root configuration. */
  modules: Record<string, string>;
}

/** The steps from a value to something in it: a key of a map or an index into a list. */
type Path = (string | number)[];

/** Where a value holds what is not known yet, as the steps to each; `[[]]` when the whole of it is not. */
function unknownPaths(value: unknown, at: Path = []): Path[] {
  if (isUnknown(value)) return [at];
  if (Array.isArray(value)) return value.flatMap((item, index) => unknownPaths(item, [...at, index]));

  return isRecord(value) ? Object.entries(value).flatMap(([key, item]) => unknownPaths(item, [...at, key])) : [];
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

/** Whether the steps land on something in the value, so a saved unknown has a place to go back into. */
function lands(value: unknown, path: Path): boolean {
  if (path.length === 0) return true;

  const [step, ...rest] = path;
  if (Array.isArray(value)) return typeof step === 'number' && Number.isInteger(step) && step >= 0 && step < value.length && lands(value[step], rest);

  return isRecord(value) && typeof step === 'string' && Object.hasOwn(value, step) && lands(value[step], rest);
}

function placeUnknown(value: unknown, path: Path): unknown {
  if (path.length === 0) return UNKNOWN;

  const [step, ...rest] = path;
  const container = value as Record<string | number, unknown>;
  container[step] = placeUnknown(container[step], rest);
  return value;
}

function readChanges(saved: Record<string, { old?: unknown; new?: unknown; unknown?: Path[] }>): Changes {
  return Object.fromEntries(
    Object.entries(saved).map(([name, change]) => [name, { old: change.old, new: (change.unknown ?? []).reduce<unknown>((value, path) => placeUnknown(value, path), change.new) }])
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
    actions: plan.actions.map((action) => (action.changes ? { ...action, changes: saveChanges(action.changes) } : action)),
    outputs: saveChanges(plan.outputs),
  };

  return JSON.stringify(file, undefined, 2);
}

function isPath(path: unknown): path is Path {
  return Array.isArray(path) && path.every((step) => typeof step === 'string' || typeof step === 'number');
}

/** One path that leads through another would put a value into what is not known yet. */
function overlaps(paths: Path[]): boolean {
  return paths.some((path, i) => paths.some((other, j) => i !== j && path.length <= other.length && path.every((step, k) => other[k] === step)));
}

/** Where a saved change says a value is not known, there has to be a place in it to put one back, and only one. */
function isUnknownPaths(change: Record<string, unknown>): boolean {
  const { unknown } = change;
  if (unknown === undefined) return true;

  return Array.isArray(unknown) && unknown.every((path) => isPath(path) && lands(change.new, path)) && !overlaps(unknown as Path[]);
}

/** Each change is read for what it held, so one that is not a record would fail far from the file it came from. */
function isChanges(changes: unknown): boolean {
  return isRecord(changes) && Object.values(changes).every((change) => isRecord(change) && isUnknownPaths(change));
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

function isAction(action: unknown): boolean {
  return (
    isRecord(action) &&
    (action.modulePath === undefined || isModulePath(action.modulePath)) &&
    (action.key === undefined || isInstanceKey(action.key)) &&
    isMovedFrom(action) &&
    (action.changes === undefined || isChanges(action.changes))
  );
}

export function validatePlanFile(planFile: unknown): planFile is PlanFile {
  if (!planFile || typeof planFile !== 'object') return false;

  const pf = planFile as Partial<PlanFile>;
  return (
    pf.version === PLAN_FILE_VERSION &&
    typeof pf.timestamp === 'string' &&
    typeof pf.config === 'string' &&
    isModuleFiles(pf.modules) &&
    typeof pf.serial === 'number' &&
    Array.isArray(pf.actions) &&
    pf.actions.every((action) => isAction(action)) &&
    isChanges(pf.outputs)
  );
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

  return {
    ...parsed,
    actions: parsed.actions.map((action) => (action.changes ? { ...action, changes: readChanges(action.changes) } : action)),
    outputs: readChanges(parsed.outputs),
  };
}

/** A map's keys written in another order is not a change. */
function valueChanged(oldValue: unknown, newValue: unknown): boolean {
  if (isUnknown(newValue)) return true;
  return !isDeepStrictEqual(oldValue, newValue);
}

/** Maps throughout: a name every object answers to would otherwise be read from the side that never set it, and `__proto__` would set a prototype instead of a key. */
function calculateDiff(oldAttrs: Record<string, unknown>, newAttrs: Record<string, unknown>): Changes | null {
  const before = new Map(Object.entries(oldAttrs));
  const after = new Map(Object.entries(newAttrs));
  const changes = new Map<string, { old: unknown; new: unknown }>();

  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const oldValue = before.get(key);
    const newValue = after.get(key);

    if (valueChanged(oldValue, newValue)) changes.set(key, { old: oldValue, new: newValue });
  }

  return changes.size > 0 ? Object.fromEntries(changes) : null;
}

export function outputChanges(current: Record<string, unknown>, desired: Record<string, unknown>): Changes {
  return calculateDiff(current, desired) ?? {};
}

/** Tells whether a resource in state would change, without building the action for it. */
export function hasChanges(currentAttrs: Record<string, unknown>, desiredAttrs: Record<string, unknown>): boolean {
  return calculateDiff(currentAttrs, desiredAttrs) !== null;
}

function processExistingResource(actions: PlanAction[], desired: DesiredResource, currentResource: Resource, schemas: Map<string, Schema>) {
  const moved = desired.movedFrom;
  const resource = desired.block;
  const changes = calculateDiff(currentResource.attributes, desired.attributes);

  if (!changes) {
    actions.push({
      type: 'NO_OP',
      ...desired.address.fields(),
      ...(moved && { movedFrom: moved }),
      id: currentResource.id,
      dependencies: desired.dependencies,
    });
    return;
  }

  const schema = schemas.get(resource.resourceType) ?? {};
  const forcesNew = Object.keys(changes).some((attr) => schema[attr]?.forceNew);

  actions.push({
    type: forcesNew ? 'REPLACE' : 'UPDATE',
    ...desired.address.fields(),
    ...(moved && { movedFrom: moved }),
    id: currentResource.id,
    attributes: resource.attributes,
    changes,
    dependencies: desired.dependencies,
  });
}

/** `currentState` is the state with every move already made, as the desired resources were planned against it. */
export function plan(desiredResources: DesiredResource[], currentState: State, schemas: Map<string, Schema> = new Map()): PlanAction[] {
  const actions: PlanAction[] = [];
  const currentMap = new Map<string, Resource>(Object.entries(currentState.resources));
  const desiredMap = new Map<string, DesiredResource>();

  for (const desired of desiredResources) desiredMap.set(desired.address.toString(), desired);

  for (const [key, desired] of desiredMap.entries()) {
    const currentResource = currentMap.get(key);
    if (currentResource) processExistingResource(actions, desired, currentResource, schemas);
    else
      actions.push({
        type: 'CREATE',
        ...desired.address.fields(),
        attributes: desired.block.attributes,
        dependencies: desired.dependencies,
      });
  }

  for (const [key, resource] of currentMap.entries()) {
    if (desiredMap.has(key)) continue;

    actions.push({
      type: 'DELETE',
      ...Address.of(resource).fields(),
      id: resource.id,
    });
  }

  return actions;
}
