import { IResource, ISchema } from '@clay/contracts';
import { AttributeValue, ResourceBlock } from '@clay/parser';
import { IState } from '@clay/state';

export type ActionType = 'CREATE' | 'UPDATE' | 'REPLACE' | 'DELETE' | 'NO_OP';

/** Stands for a value that only exists once the resources it depends on are created. */
const UNKNOWN_KEY = '@@clay/unknown';

export const UNKNOWN = { [UNKNOWN_KEY]: true } as const;

export function isUnknown(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as Record<string, unknown>)[UNKNOWN_KEY] === true;
}

/** A resource from the config: the block to execute, and its values with references resolved. */
export interface DesiredResource {
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
export const PLAN_FILE_VERSION = '5.0';

export interface PlanFile extends Plan {
  version: string;
  timestamp: string;
  /** The configuration the plan was made from. A saved plan runs against it, not against whatever is on disk later. */
  config: string;
  /** The module files it read, by path relative to the root configuration. */
  modules: Record<string, string>;
}

export function serializePlan(plan: Plan, configContent: string, modules: Record<string, string>): PlanFile {
  return {
    version: PLAN_FILE_VERSION,
    timestamp: new Date().toISOString(),
    config: configContent,
    modules,
    serial: plan.serial,
    actions: plan.actions,
    outputs: plan.outputs,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
    isRecord(pf.outputs)
  );
}

function valueChanged(oldValue: unknown, newValue: unknown): boolean {
  if (isUnknown(newValue)) return true;
  return JSON.stringify(oldValue) !== JSON.stringify(newValue);
}

function calculateDiff(oldAttrs: Record<string, unknown>, newAttrs: Record<string, unknown>): Changes | null {
  const changes: Changes = {};
  let changed = false;

  const allKeys = new Set([...Object.keys(oldAttrs), ...Object.keys(newAttrs)]);

  for (const key of allKeys) {
    const oldValue = oldAttrs[key];
    const newValue = newAttrs[key];

    if (valueChanged(oldValue, newValue)) {
      changes[key] = { old: oldValue, new: newValue };
      changed = true;
    }
  }

  return changed ? changes : null;
}

export function outputChanges(current: Record<string, unknown>, desired: Record<string, unknown>): Changes {
  return calculateDiff(current, desired) ?? {};
}

/** Tells whether a resource in state would change, without building the action for it. */
export function hasChanges(currentAttrs: Record<string, unknown>, desiredAttrs: Record<string, unknown>): boolean {
  return calculateDiff(currentAttrs, desiredAttrs) !== null;
}

function getResourceKey(resource: ResourceBlock): string {
  const prefix = (resource.modulePath || []).map((m: string) => `module.${m}`).join('.');
  const suffix = `${resource.resourceType}.${resource.name}`;
  return prefix ? `${prefix}.${suffix}` : suffix;
}

function processExistingResource(actions: PlanAction[], desired: DesiredResource, currentResource: IResource, schemas: Record<string, ISchema>) {
  const resource = desired.block;
  const changes = calculateDiff(currentResource.attributes, desired.attributes);

  if (!changes) {
    actions.push({
      type: 'NO_OP',
      resourceType: resource.resourceType,
      name: resource.name,
      modulePath: resource.modulePath,
      id: currentResource.id,
      dependencies: desired.dependencies,
    });
    return;
  }

  const schema = schemas[resource.resourceType] || {};
  const forcesNew = Object.keys(changes).some((attr) => schema[attr]?.forceNew);

  actions.push({
    type: forcesNew ? 'REPLACE' : 'UPDATE',
    resourceType: resource.resourceType,
    name: resource.name,
    modulePath: resource.modulePath,
    id: currentResource.id,
    attributes: resource.attributes,
    changes,
    dependencies: desired.dependencies,
  });
}

export function plan(desiredResources: DesiredResource[], currentState: IState, schemas: Record<string, ISchema> = {}): PlanAction[] {
  const actions: PlanAction[] = [];
  const currentMap = new Map<string, IResource>(Object.entries(currentState.resources));
  const desiredMap = new Map<string, DesiredResource>();

  for (const desired of desiredResources) desiredMap.set(getResourceKey(desired.block), desired);

  // 1. Check for Create, Update, or Replace
  for (const [key, desired] of desiredMap.entries()) {
    const currentResource = currentMap.get(key);
    if (currentResource) processExistingResource(actions, desired, currentResource, schemas);
    else
      actions.push({
        type: 'CREATE',
        resourceType: desired.block.resourceType,
        name: desired.block.name,
        modulePath: desired.block.modulePath,
        attributes: desired.block.attributes,
        dependencies: desired.dependencies,
      });
  }

  // 2. Check for Delete (In state but not in desired)
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
