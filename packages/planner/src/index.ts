import { IResource, ISchema } from '@miniform/contracts';
import { AttributeValue, ResourceBlock } from '@miniform/parser';
import { IState } from '@miniform/state';
import crypto from 'node:crypto';

export type ActionType = 'CREATE' | 'UPDATE' | 'REPLACE' | 'DELETE' | 'NO_OP';

/** Stands for a value that only exists once the resources it depends on are created. */
const UNKNOWN_KEY = '@@miniform/unknown';

export const UNKNOWN = { [UNKNOWN_KEY]: true } as const;

export function isUnknown(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as Record<string, unknown>)[UNKNOWN_KEY] === true;
}

/** A resource from the config: the block to execute, and its values with references resolved. */
export interface DesiredResource {
  block: ResourceBlock;
  attributes: Record<string, unknown>;
}

export interface PlanAction {
  type: ActionType;
  resourceType: string;
  name: string;
  modulePath?: string[]; // Path of modules leading to this resource
  id?: string;
  attributes?: Record<string, AttributeValue>;
  changes?: Record<string, { old: unknown; new: unknown }>;
}

export interface PlanFile {
  version: string;
  timestamp: string;
  configHash: string;
  actions: PlanAction[];
}

export function serializePlan(actions: PlanAction[], configContent: string): PlanFile {
  const hash = crypto.createHash('sha256').update(configContent).digest('hex');

  return {
    version: '1.0',
    timestamp: new Date().toISOString(),
    configHash: hash,
    actions,
  };
}

export function validatePlanFile(planFile: unknown): planFile is PlanFile {
  if (!planFile || typeof planFile !== 'object') return false;

  const pf = planFile as Partial<PlanFile>;
  return typeof pf.version === 'string' && typeof pf.timestamp === 'string' && typeof pf.configHash === 'string' && Array.isArray(pf.actions);
}

function valueChanged(oldValue: unknown, newValue: unknown): boolean {
  if (isUnknown(newValue)) return true;
  return JSON.stringify(oldValue) !== JSON.stringify(newValue);
}

function calculateDiff(oldAttrs: Record<string, unknown>, newAttrs: Record<string, unknown>): Record<string, { old: unknown; new: unknown }> | null {
  const changes: Record<string, { old: unknown; new: unknown }> = {};
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
