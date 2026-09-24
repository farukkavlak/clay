import { Address, Resource, Schema, State } from '@clay/contracts';
import { AttributeValue, ResourceBlock } from '@clay/parser';
import { isDeepStrictEqual } from 'node:util';

export type ActionType = 'CREATE' | 'UPDATE' | 'REPLACE' | 'DELETE' | 'NO_OP';

/** Stands for a value that only exists once the resources it depends on are created. A symbol, so no value a configuration or a file holds can pass for it. */
export const UNKNOWN: unique symbol = Symbol('unknown');

export function isUnknown(value: unknown): boolean {
  return value === UNKNOWN;
}

/** A resource from the config: where it lives, the block as parsed, and its values with references resolved. */
export interface DesiredResource {
  address: Address;
  block: ResourceBlock;
  attributes: Record<string, unknown>;
  dependencies: string[];
}

/** What each named value was and would become; a missing `old` is an addition, a missing `new` a removal. */
export type Changes = Record<string, { old: unknown; new: unknown }>;

export interface PlanAction {
  type: ActionType;
  resourceType: string;
  name: string;
  modulePath?: string[]; // Path of modules leading to this resource
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

/** Bumped whenever the shape below changes, so a plan file from an older version is refused instead of misread. */
export const PLAN_FILE_VERSION = '6.0';

export interface PlanFile extends Plan {
  version: string;
  timestamp: string;
  /** The configuration the plan was made from. A saved plan runs against it, not against whatever is on disk later. */
  config: string;
  /** The module files it read, by path relative to the root configuration. */
  modules: Record<string, string>;
}

/** A value not known yet has no form in JSON, so a saved change says so beside `old` instead of holding one. */
function saveChanges(changes: Changes): Record<string, unknown> {
  return Object.fromEntries(Object.entries(changes).map(([name, change]) => [name, isUnknown(change.new) ? { old: change.old, unknown: true } : change]));
}

function readChanges(saved: Record<string, { old?: unknown; new?: unknown; unknown?: unknown }>): Changes {
  return Object.fromEntries(Object.entries(saved).map(([name, change]) => [name, { old: change.old, new: change.unknown === true ? UNKNOWN : change.new }]));
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

  // Anywhere but a whole change, JSON has no form for a value not known yet and would write something else without a word.
  return JSON.stringify(
    file,
    (_, value: unknown) => {
      if (isUnknown(value)) throw new Error('A value not known yet sits inside another value, where a plan file cannot hold it');

      return value;
    },
    2
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Each change is read for what it held, so one that is not a record would fail far from the file it came from. */
function isChanges(changes: unknown): boolean {
  return isRecord(changes) && Object.values(changes).every((change) => isRecord(change));
}

function isModuleFiles(modules: unknown): modules is Record<string, string> {
  return isRecord(modules) && Object.values(modules).every((content) => typeof content === 'string');
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
    pf.actions.every((action) => isRecord(action) && (action.changes === undefined || isChanges(action.changes))) &&
    isChanges(pf.outputs)
  );
}

/** A plan file is written by `plan`, never by hand, so the only answer to a broken one is to plan again: the reason it is broken would not help. */
function planVersion(parsed: unknown): string | undefined {
  if (!isRecord(parsed) || !Array.isArray(parsed.actions)) return undefined;

  return typeof parsed.version === 'string' ? parsed.version : undefined;
}

/** `source` names the plan in the error, since the caller knows where it read from and this does not. */
export function parsePlanFile(content: string, source: string): PlanFile {
  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`${source} is not a plan file: the file is not JSON`, { cause: error });
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
  const resource = desired.block;
  const { modulePath } = desired.address;
  const changes = calculateDiff(currentResource.attributes, desired.attributes);

  if (!changes) {
    actions.push({
      type: 'NO_OP',
      resourceType: resource.resourceType,
      name: resource.name,
      modulePath,
      id: currentResource.id,
      dependencies: desired.dependencies,
    });
    return;
  }

  const schema = schemas.get(resource.resourceType) ?? {};
  const forcesNew = Object.keys(changes).some((attr) => schema[attr]?.forceNew);

  actions.push({
    type: forcesNew ? 'REPLACE' : 'UPDATE',
    resourceType: resource.resourceType,
    name: resource.name,
    modulePath,
    id: currentResource.id,
    attributes: resource.attributes,
    changes,
    dependencies: desired.dependencies,
  });
}

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
        resourceType: desired.block.resourceType,
        name: desired.block.name,
        modulePath: desired.address.modulePath,
        attributes: desired.block.attributes,
        dependencies: desired.dependencies,
      });
  }

  for (const [key, resource] of currentMap.entries()) {
    if (desiredMap.has(key)) continue;

    actions.push({
      type: 'DELETE',
      resourceType: resource.resourceType,
      name: resource.name,
      modulePath: resource.modulePath,
      id: resource.id,
    });
  }

  return actions;
}
