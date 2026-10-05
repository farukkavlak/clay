import { Address, State } from '@clay/contracts';

/** Rewrites or drops dependencies, so none points at an address that no longer holds a resource. */
export function mapDependencies(state: State, change: (dependency: string) => string | undefined): void {
  for (const resource of Object.values(state.resources))
    if (resource.dependencies) resource.dependencies = resource.dependencies.map((dependency) => change(dependency)).filter((dependency) => dependency !== undefined);
}

/** The address lives in the key, the entry and every dependency on it; all of them move. */
export function moveResource(state: State, from: Address, to: Address): void {
  // Moving a missing entry would create an empty one.
  if (!Object.hasOwn(state.resources, from.toString())) throw new Error(`Cannot move ${from.toString()}: state has no resource there`);

  state.resources[to.toString()] = { ...state.resources[from.toString()], ...to.fields() };
  delete state.resources[from.toString()];
  mapDependencies(state, (dependency) => (dependency === from.toString() ? to.toString() : dependency));
}
