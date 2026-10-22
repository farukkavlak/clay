import { Address, State } from '@clay/contracts';

/** Rewrites or drops dependencies, so none points at an address that no longer holds a resource. */
export function mapDependencies(state: State, change: (dependency: string) => string | undefined): void {
  const mapped = (dependencies: string[]) => dependencies.map((dependency) => change(dependency)).filter((dependency) => dependency !== undefined);

  for (const resource of Object.values(state.resources)) if (resource.dependencies) resource.dependencies = mapped(resource.dependencies);
  const { deposed = {} } = state;
  // New objects, since a copy of the map shares the ones in it.
  for (const [address, objects] of Object.entries(deposed))
    deposed[address] = objects.map((object) => (object.dependencies ? { ...object, dependencies: mapped(object.dependencies) } : object));
}

/** What a replace left behind goes with the resource it was left by. */
function moveDeposed(state: State, from: string, to: string): void {
  if (!state.deposed || !Object.hasOwn(state.deposed, from)) return;

  state.deposed[to] = [...(state.deposed[to] ?? []), ...state.deposed[from]];
  delete state.deposed[from];
}

/** The address lives in the key, the entry and every dependency on it; all of them move. */
export function moveResource(state: State, from: Address, to: Address): void {
  // Moving a missing entry would create an empty one.
  if (!Object.hasOwn(state.resources, from.toString())) throw new Error(`Cannot move ${from.toString()}: state has no resource there`);

  state.resources[to.toString()] = { ...state.resources[from.toString()], ...to.fields() };
  delete state.resources[from.toString()];
  moveDeposed(state, from.toString(), to.toString());
  mapDependencies(state, (dependency) => (dependency === from.toString() ? to.toString() : dependency));
}
