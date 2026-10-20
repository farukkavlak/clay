import { Address, State } from '@clay/contracts';
import { spell } from '@clay/parser';
import { DesiredResource, PlanAction } from '@clay/planner';

import { withPlace } from './place';
import { ProviderRegistry } from './ProviderRegistry';

/** An object the plan destroys: a delete's, a deposed one, or the old one of a replace. */
interface Going {
  action: PlanAction;
  address: string;
  deposed: boolean;
  values: Record<string, unknown>;
}

type Identify = (type: string, values: Record<string, unknown>) => Promise<string | undefined>;

function goingIn(actions: PlanAction[], state: State): Going[] {
  return actions.flatMap<Going>((action) => {
    const address = Address.of(action).toString();
    if (action.deposed) return (state.deposed?.[address] ?? []).map(({ attributes }) => ({ action, address, deposed: true, values: attributes }));
    if (action.type === 'DELETE' || action.type === 'REPLACE') return [{ action, address, deposed: false, values: state.resources[address].attributes }];

    return [];
  });
}

function refused(resource: DesiredResource, message: string): Error {
  return withPlace(new Error(message), resource.block.position, spell(resource.block), resource.address.module);
}

/** Each object the plan leaves, by what it is. Two that are one thing would write over each other. */
async function stayingByIdentity(desired: DesiredResource[], identify: Identify): Promise<Map<string, DesiredResource>> {
  const staying = new Map<string, DesiredResource>();

  for (const resource of desired) {
    const identity = await identify(resource.address.resourceType, resource.after);
    if (identity === undefined) continue;

    const other = staying.get(identity);
    if (other) throw refused(resource, `${resource.address} and ${other.address} are both ${identity}, so each would write over the other. Give each its own.`);
    staying.set(identity, resource);
  }

  return staying;
}

function destroysWhatStays(resource: DesiredResource, identity: string, going: Going, actions: PlanAction[]): Error {
  const address = resource.address.toString();
  const holder = going.deposed ? `a deposed object of ${going.address}` : going.address;
  const renamed = !going.deposed && going.action.type === 'DELETE' && actions.some((action) => action.type === 'CREATE' && Address.of(action).toString() === address);
  const move = renamed ? ` If ${going.address} was renamed to ${address}, move it in the state first: clay state mv ${going.address} ${address}` : '';

  return refused(resource, `${address} is ${identity}, which ${holder} holds and this plan destroys, so the destroy would remove it.${move}`);
}

/** Refused, except a replace's own old object destroyed before its new one is made. */
function checkGoing(going: Going, identity: string, resource: DesiredResource, actions: PlanAction[]): void {
  if (going.deposed || resource.address.toString() !== going.address) throw destroysWhatStays(resource, identity, going, actions);
  if (going.action.createBeforeDestroy)
    throw refused(resource, `${going.address} makes its new object before it destroys the old one, but both are ${identity}, so the destroy would remove the new one.`);
}

/** Two objects that are one real thing, as two files at one path, would overwrite or destroy each other. Only the provider can tell. */
export async function checkSameObjects(actions: PlanAction[], desired: DesiredResource[], state: State, providers: ProviderRegistry): Promise<void> {
  const identify: Identify = async (type, values) => await providers.get(type).identify?.(type, values);
  const staying = await stayingByIdentity(desired, identify);

  for (const going of goingIn(actions, state)) {
    const identity = await identify(going.action.resourceType, going.values);
    if (identity === undefined) continue;

    const resource = staying.get(identity);
    if (resource) checkGoing(going, identity, resource, actions);
  }
}
