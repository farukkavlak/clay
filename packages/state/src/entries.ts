import { Address, State } from '@clay/contracts';

/** State would keep a dependency on an address that no longer holds a resource. */
export function mapDependencies(state: State, change: (dependency: string) => string | undefined): void {
  for (const resource of Object.values(state.resources))
    if (resource.dependencies) resource.dependencies = resource.dependencies.map((dependency) => change(dependency)).filter((dependency) => dependency !== undefined);
}

/** A resource's address lives in its key, in its entry and in every entry that reads from it. */
export function moveResource(state: State, from: Address, to: Address): void {
  // An entry made from nothing would hold no attributes.
  if (!Object.hasOwn(state.resources, from.toString())) throw new Error(`Cannot move ${from.toString()}: state has no resource there`);

  state.resources[to.toString()] = { ...state.resources[from.toString()], ...to.fields() };
  delete state.resources[from.toString()];
  mapDependencies(state, (dependency) => (dependency === from.toString() ? to.toString() : dependency));
}
