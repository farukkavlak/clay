import { Address, Resource, samePaths, State } from '@clay/contracts';

import { calculateDiff } from './diff';
import { DesiredResource, PlanAction } from './Plan';

function marked({ sensitive }: DesiredResource): Pick<PlanAction, 'sensitive'> {
  return sensitive.length > 0 ? { sensitive } : {};
}

function ignoring({ ignored }: DesiredResource): Pick<PlanAction, 'ignored'> {
  return ignored && ignored.length > 0 ? { ignored } : {};
}

function prevents({ block }: DesiredResource): boolean {
  return block.lifecycle?.preventDestroy === true;
}

function protectedBy(desired: DesiredResource): Pick<PlanAction, 'preventDestroy'> {
  return prevents(desired) ? { preventDestroy: true } : {};
}

/** What an update or a replace holds of its resource beside the values. */
function carriedOver(desired: DesiredResource): Pick<PlanAction, 'sensitive' | 'preventDestroy' | 'ignored' | 'createBeforeDestroy'> {
  return { ...marked(desired), ...protectedBy(desired), ...ignoring(desired), ...(desired.replace && desired.createBeforeDestroy && { createBeforeDestroy: true as const }) };
}

function processExistingResource(actions: PlanAction[], desired: DesiredResource, currentResource: Resource) {
  const moved = desired.movedFrom;
  const changes = calculateDiff(currentResource.attributes, desired.after);

  if (!changes && !desired.replace) {
    actions.push({
      type: 'NO_OP',
      ...desired.address.fields(),
      ...(moved && { movedFrom: moved }),
      ...marked(desired),
      ...protectedBy(desired),
      ...(!samePaths(currentResource.sensitive ?? [], desired.sensitive) && { marksChange: true }),
      ...(prevents(desired) !== (currentResource.preventDestroy === true) && { protectionChange: true }),
      dependencies: desired.dependencies,
    });
    return;
  }

  actions.push({
    type: desired.replace ? 'REPLACE' : 'UPDATE',
    ...desired.address.fields(),
    ...(moved && { movedFrom: moved }),
    planned: desired.attributes,
    after: desired.after,
    ...carriedOver(desired),
    changes: changes ?? {},
    dependencies: desired.dependencies,
  });
}

/** `currentState` already has every move applied. */
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
        planned: desired.attributes,
        after: desired.after,
        ...marked(desired),
        ...protectedBy(desired),
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

  // Whether or not the resource they were left by is still there.
  for (const address of Object.keys(currentState.deposed ?? {})) actions.push({ type: 'DELETE', deposed: true, ...Address.parse(address).fields() });

  return actions;
}
