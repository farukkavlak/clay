import { Address, State } from '@clay/contracts';
import { spell } from '@clay/parser';
import { DesiredResource, PlanAction } from '@clay/planner';

import { asError } from './asError';
import { withPlace } from './place';
import { ProviderRegistry } from './ProviderRegistry';

/** An object the plan destroys: a delete's, a deposed one, or the old one of a replace. */
interface Going {
  action: PlanAction;
  address: string;
  deposed: boolean;
  values: Record<string, unknown>;
}

/** An object the plan makes or keeps, and how a refusal names it. */
interface Staying {
  address: string;
  /** A create, so a delete elsewhere may be its rename. */
  created: boolean;
  refuse: (message: string) => Error;
}

type Identify = (type: string, values: Record<string, unknown>) => Promise<string | undefined>;

const identifyWith =
  (providers: ProviderRegistry): Identify =>
  async (type, values) =>
    await providers.get(type).identify?.(type, values);

/** A failure names what was asked about. */
async function asking(identify: Identify, type: string, values: Record<string, unknown>, name: (error: unknown) => Error): Promise<string | undefined> {
  try {
    return await identify(type, values);
  } catch (error) {
    throw name(error);
  }
}

const named = (address: string) => (error: unknown) => new Error(`${address}: ${asError(error).message}`, { cause: error });

function goingIn(actions: PlanAction[], state: State): Going[] {
  return actions.flatMap<Going>((action) => {
    const address = Address.of(action).toString();
    if (action.deposed) return (state.deposed?.[address] ?? []).map(({ attributes }) => ({ action, address, deposed: true, values: attributes }));
    if (action.type === 'DELETE' || action.type === 'REPLACE') return [{ action, address, deposed: false, values: state.resources[address].attributes }];

    return [];
  });
}

function checkOther(staying: Staying, identity: string, other: string): void {
  if (other !== staying.address) throw staying.refuse(`${staying.address} and ${other} are both ${identity}, so each would write over the other. Give each its own.`);
}

function destroysWhatStays(staying: Staying, identity: string, going: Going): Error {
  const { address } = staying;
  const holder = going.deposed ? `a deposed object of ${going.address}` : going.address;
  const renamed = !going.deposed && going.action.type === 'DELETE' && staying.created;
  const move = renamed ? ` If ${going.address} was renamed to ${address}, move it in the state first: clay state mv ${going.address} ${address}` : '';

  return staying.refuse(`${address} is ${identity}, which ${holder} holds and this plan destroys, so the destroy would remove it.${move}`);
}

/** Refused, except a replace's own old object destroyed before its new one is made. */
function checkGoing(going: Going, identity: string, staying: Staying): void {
  if (going.deposed || staying.address !== going.address) throw destroysWhatStays(staying, identity, going);
  if (going.action.createBeforeDestroy)
    throw staying.refuse(`${going.address} makes its new object before it destroys the old one, but both are ${identity}, so the destroy would remove the new one.`);
}

function planned(resource: DesiredResource, actions: PlanAction[]): Staying {
  const address = resource.address.toString();

  return {
    address,
    created: actions.some((action) => action.type === 'CREATE' && Address.of(action).toString() === address),
    refuse: (message) => withPlace(new Error(message), resource.block.position, spell(resource.block), resource.address.module),
  };
}

/** Two objects that are one real thing, as two files at one path, would overwrite or destroy each other. Only the provider can tell. */
export async function checkSameObjects(actions: PlanAction[], desired: DesiredResource[], state: State, providers: ProviderRegistry): Promise<void> {
  const identify = identifyWith(providers);
  const staying = new Map<string, Staying>();

  for (const resource of desired) {
    const placed = (error: unknown) => withPlace(error, resource.block.position, spell(resource.block), resource.address.module);
    const identity = await asking(identify, resource.address.resourceType, resource.after, placed);
    if (identity === undefined) continue;

    const object = planned(resource, actions);
    const other = staying.get(identity);
    if (other) checkOther(object, identity, other.address);
    staying.set(identity, object);
  }

  for (const going of goingIn(actions, state)) {
    const identity = await asking(identify, going.action.resourceType, going.values, named(going.address));
    if (identity === undefined) continue;

    const object = staying.get(identity);
    if (object) checkGoing(going, identity, object);
  }
}

/**
 * The same check at apply, for values only the apply knows. Only what exists then counts: an object already destroyed removes
 * nothing, so a create after it is safe.
 */
export class SameObjects {
  private readonly identify: Identify;
  private going = new Map<Record<string, unknown>, Going>();
  /** What each object being made or changed in this run is, before it reaches the state. */
  private claimed = new Map<string, string>();
  /** Asked once per state object: the state replaces values on a change, never changes them. */
  private known = new WeakMap<Record<string, unknown>, Promise<string | undefined>>();

  constructor(providers: ProviderRegistry) {
    this.identify = identifyWith(providers);
  }

  /** The objects the plan destroys, as the state holds them before the run. */
  expect(actions: PlanAction[], state: State): void {
    this.going = new Map(goingIn(actions, state).map((going) => [going.values, going]));
  }

  /** Refused before the provider makes or changes the object. Nothing is awaited between the check and the claim. */
  async claim(action: PlanAction, values: Record<string, unknown>, state: State): Promise<void> {
    const address = Address.of(action).toString();
    const identity = await asking(this.identify, action.resourceType, values, named(address));
    if (identity === undefined) return;

    const held = await this.heldAs(identity, state);
    const staying: Staying = { address, created: action.type === 'CREATE', refuse: (message) => new Error(message) };
    const other = this.claimed.get(identity);
    if (other) checkOther(staying, identity, other);
    for (const { address: holder, values: attributes } of held) {
      const going = this.going.get(attributes);
      if (going) checkGoing(going, identity, staying);
      else checkOther(staying, identity, holder);
    }

    this.claimed.set(identity, staying.address);
  }

  /** Each object the state holds now, current or deposed, that is the given thing. */
  private async heldAs(identity: string, state: State): Promise<{ address: string; values: Record<string, unknown> }[]> {
    const objects = [
      ...Object.entries(state.resources).map(([address, resource]) => ({ address, type: resource.resourceType, values: resource.attributes })),
      ...Object.entries(state.deposed ?? {}).flatMap(([address, deposed]) =>
        deposed.map(({ attributes }) => ({ address, type: Address.parse(address).resourceType, values: attributes }))
      ),
    ];
    const identities = await Promise.all(objects.map(({ address, type, values }) => this.identifyHeld(address, type, values)));

    return objects.filter((_, index) => identities[index] === identity);
  }

  private identifyHeld(address: string, type: string, values: Record<string, unknown>): Promise<string | undefined> {
    const known = this.known.get(values) ?? asking(this.identify, type, values, named(address));
    this.known.set(values, known);

    return known;
  }
}
