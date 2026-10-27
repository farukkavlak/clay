import { Address, AttributePath, Identity, State } from '@clay/contracts';
import { spell } from '@clay/parser';
import { PlanAction } from '@clay/planner';

import { append } from '../append';
import { asError } from '../asError';
import { ConfiguredResource } from '../plan/DesiredStateBuilder';
import { withPlace } from '../place';
import { hidingReason } from '../providers/providerResult';
import { ProviderRegistry } from '../providers/ProviderRegistry';
import { Limit, taken } from '../providers/Limit';

/** An object the plan destroys: a delete's, a deposed one, or the old one of a replace. */
interface Going {
  action: PlanAction;
  address: string;
  deposed: boolean;
  values: Record<string, unknown>;
  sensitive: AttributePath[];
}

/** An object the plan makes or keeps, and how a refusal names it. */
interface Staying {
  address: string;
  /** A create, so a delete elsewhere may be its rename. */
  created: boolean;
  refuse: (message: string) => Error;
}

type Identify = (type: string, values: Record<string, unknown>, sensitive: readonly AttributePath[]) => Promise<Identity | undefined>;

const identifyWith =
  (providers: ProviderRegistry, limit: Limit): Identify =>
  async (type, values, sensitive) =>
    await limit.run(async () => await hidingReason(type, sensitive, async () => await providers.get(type).identify?.(type, values), 'to identify'));

/** A failure names what was asked about. */
async function asking(
  identify: Identify,
  type: string,
  values: Record<string, unknown>,
  sensitive: readonly AttributePath[],
  name: (error: unknown) => Error
): Promise<Identity | undefined> {
  try {
    return await identify(type, values, sensitive);
  } catch (error) {
    throw name(error);
  }
}

const named = (address: string) => (error: unknown) => new Error(`${address}: ${asError(error).message}`, { cause: error });

function goingIn(actions: PlanAction[], state: State): Going[] {
  return actions.flatMap<Going>((action) => {
    const address = Address.of(action).toString();
    if (action.deposed) return (state.deposed?.[address] ?? []).map(({ attributes, sensitive = [] }) => ({ action, address, deposed: true, values: attributes, sensitive }));
    if (action.type === 'DELETE' || action.type === 'REPLACE') {
      const { attributes, sensitive = [] } = state.resources[address];
      return [{ action, address, deposed: false, values: attributes, sensitive }];
    }

    return [];
  });
}

function checkOther(staying: Staying, thing: string, other: string): void {
  if (other !== staying.address) throw staying.refuse(`${staying.address} and ${other} are both ${thing}, so each would write over the other. Give each its own.`);
}

function destroysWhatStays(staying: Staying, thing: string, going: Going): Error {
  const { address } = staying;
  const holder = going.deposed ? `a deposed object of ${going.address}` : going.address;
  const renamed = !going.deposed && going.action.type === 'DELETE' && staying.created;
  const move = renamed ? ` If ${going.address} was renamed to ${address}, say so in the root module: moved { from = ${going.address} to = ${address} }` : '';

  return staying.refuse(`${address} is ${thing}, which ${holder} holds and this plan destroys, so the destroy would remove it.${move}`);
}

/** Refused, except a replace's own old object destroyed before its new one is made. */
function checkGoing(going: Going, thing: string, staying: Staying): void {
  if (going.deposed || staying.address !== going.address) throw destroysWhatStays(staying, thing, going);
  if (going.action.createBeforeDestroy)
    throw staying.refuse(`${going.address} makes its new object before it destroys the old one, but both are ${thing}, so the destroy would remove the new one.`);
}

function planned(resource: ConfiguredResource, created: Set<string>): Staying {
  const address = resource.address.toString();

  return {
    address,
    created: created.has(address),
    refuse: (message) => withPlace(new Error(message), resource.block.position, spell(resource.block), resource.address.module),
  };
}

/** Two objects that are one real thing, as two files at one path, would overwrite or destroy each other. Only the provider can tell. */
export async function checkSameObjects(actions: PlanAction[], desired: ConfiguredResource[], state: State, providers: ProviderRegistry, limit: Limit): Promise<void> {
  const identify = identifyWith(providers, limit);
  const staying = new Map<string, Staying>();
  const created = new Set(actions.filter((action) => action.type === 'CREATE').map((action) => Address.of(action).toString()));
  const going = goingIn(actions, state);
  // Asked all at once, and taken in order, so the first refusal is the one a check one at a time would find.
  const [identities, goingIdentities] = await Promise.all([
    Promise.allSettled(
      desired.map((resource) => {
        const placed = (error: unknown) => withPlace(error, resource.block.position, spell(resource.block), resource.address.module);
        return asking(identify, resource.address.resourceType, resource.after, resource.sensitive, placed);
      })
    ),
    Promise.allSettled(going.map((each) => asking(identify, each.action.resourceType, each.values, each.sensitive, named(each.address)))),
  ]);

  for (const [index, resource] of desired.entries()) {
    const identity = taken(identities[index]);
    if (identity === undefined) continue;

    const object = planned(resource, created);
    const other = staying.get(identity.key);
    if (other) checkOther(object, identity.name, other.address);
    staying.set(identity.key, object);
  }

  for (const [index, each] of going.entries()) {
    const identity = taken(goingIdentities[index]);
    if (identity === undefined) continue;

    const object = staying.get(identity.key);
    if (object) checkGoing(each, identity.name, object);
  }
}

/** An object as the state holds it, and what it is. */
interface Held {
  address: string;
  values: Record<string, unknown>;
}

/** The state's objects by what thing each is, and any its provider could not identify. */
interface HeldIndex {
  byKey: Map<string, Held[]>;
  failed: (Held & { error: unknown })[];
}

/** The state replaces values on a change, so an object is still held only where its values still are. */
function stillHeld(state: State, { address, values }: Held): boolean {
  if (Object.hasOwn(state.resources, address) && state.resources[address].attributes === values) return true;

  return (state.deposed?.[address] ?? []).some((object) => object.attributes === values);
}

/**
 * The same check at apply, for values only the apply knows. Only what exists then counts: an object already destroyed removes
 * nothing, so a create after it is safe.
 */
export class SameObjects {
  private readonly identify: Identify;
  private going = new Map<Record<string, unknown>, Going>();
  /** What each object being made or changed in this run is, by key, before it reaches the state. */
  private claimed = new Map<string, string>();
  /** Built at the first claim, so each claim looks its thing up instead of going over every object again. */
  private held?: Promise<HeldIndex>;

  constructor(providers: ProviderRegistry, limit: Limit) {
    this.identify = identifyWith(providers, limit);
  }

  /** The objects the plan destroys, as the state holds them before the run. */
  expect(actions: PlanAction[], state: State): void {
    this.going = new Map(goingIn(actions, state).map((going) => [going.values, going]));
  }

  /** Refused before the provider makes or changes the object. Nothing is awaited between the check and the claim. */
  async claim(action: PlanAction, values: Record<string, unknown>, sensitive: readonly AttributePath[], state: State): Promise<void> {
    const address = Address.of(action).toString();
    // Not named: the run reports a failure by its action.
    const identity = await this.identify(action.resourceType, values, sensitive);
    if (identity === undefined) return;

    const held = await this.heldAs(identity.key, state, address);
    const staying: Staying = { address, created: action.type === 'CREATE', refuse: (message) => new Error(message) };
    const other = this.claimed.get(identity.key);
    if (other) checkOther(staying, identity.name, other);
    for (const { address: holder, values: attributes } of held) {
      const going = this.going.get(attributes);
      if (going) checkGoing(going, identity.name, staying);
      else checkOther(staying, identity.name, holder);
    }

    this.claimed.set(identity.key, staying.address);
  }

  /**
   * Each object the state holds now, current or deposed, whose thing has the `key`. One made in this run is in `claimed`.
   * A failure names another object than the `claimant`'s, which the run names.
   */
  private async heldAs(key: string, state: State, claimant: string): Promise<Held[]> {
    this.held ??= this.indexHeld(state);
    const { byKey, failed } = await this.held;

    // As every claim asked about every object the state holds then.
    const failure = failed.find((object) => stillHeld(state, object));
    if (failure) throw failure.address === claimant ? failure.error : named(failure.address)(failure.error);

    return (byKey.get(key) ?? []).filter((object) => stillHeld(state, object));
  }

  private async indexHeld(state: State): Promise<HeldIndex> {
    const objects = [
      ...Object.entries(state.resources).map(([address, resource]) => ({ address, type: resource.resourceType, values: resource.attributes, sensitive: resource.sensitive ?? [] })),
      ...Object.entries(state.deposed ?? {}).flatMap(([address, deposed]) =>
        deposed.map(({ attributes, sensitive = [] }) => ({ address, type: Address.parse(address).resourceType, values: attributes, sensitive }))
      ),
    ];
    const index: HeldIndex = { byKey: new Map(), failed: [] };
    const identities = await Promise.allSettled(objects.map(async ({ type, values, sensitive }) => await this.identify(type, values, sensitive)));

    for (const [at, identity] of identities.entries()) {
      const { address, values } = objects[at];
      if (identity.status === 'rejected') index.failed.push({ address, values, error: identity.reason });
      else if (identity.value) append(index.byKey, identity.value.key, { address, values });
    }

    return index;
  }
}
