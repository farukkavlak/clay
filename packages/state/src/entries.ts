import { Address, covers, ModuleAddress, State } from '@clay/contracts';

/** Changes the dependencies of every resource and deposed object. */
function mapDependencies(state: State, change: (dependencies: string[]) => string[]): void {
  for (const resource of Object.values(state.resources)) if (resource.dependencies) resource.dependencies = change(resource.dependencies);
  const { deposed = {} } = state;
  // New objects, since a copy of the map shares the ones in it.
  for (const [address, objects] of Object.entries(deposed))
    deposed[address] = objects.map((object) => (object.dependencies ? { ...object, dependencies: change(object.dependencies) } : object));
}

function coveringAny(dependency: string, objects: Address[]): boolean {
  const parsed = Address.parse(dependency);
  return objects.some((object) => covers(parsed, object));
}

/** Every object state holds, current or deposed. */
function objectsIn(state: State): Address[] {
  return [...Object.values(state.resources).map((resource) => Address.of(resource)), ...Object.keys(state.deposed ?? {}).map((address) => Address.parse(address))];
}

/** A dependency that covered `removed` and covers nothing left is dropped; one that covers another object still orders its delete. */
export function forgetDependencies(state: State, removed: Address): void {
  const left = objectsIn(state);
  // Once for each dependency, since every reader of a block names it the same way.
  const kept = new Map<string, boolean>();
  const keeps = (dependency: string) => {
    if (!kept.has(dependency)) kept.set(dependency, !coveringAny(dependency, [removed]) || coveringAny(dependency, left));
    return kept.get(dependency)!;
  };

  mapDependencies(state, (dependencies) => dependencies.filter((dependency) => keeps(dependency)));
}

/** What a replace left behind goes with the resource it was left by. */
function moveDeposed(state: State, from: string, to: string): void {
  if (!state.deposed || !Object.hasOwn(state.deposed, from)) return;

  state.deposed[to] = [...(state.deposed[to] ?? []), ...state.deposed[from]];
  delete state.deposed[from];
}

/** `to`'s block, keyed only at the module steps where `dependency` names one instance, so it covers what `dependency` covered there. */
function movedTo(dependency: Address, to: Address): string {
  const path = to.module.path.map((step, index) => (dependency.module.path[index]?.key === undefined ? { name: step.name } : step));

  return new Address(new ModuleAddress(path), to.resourceType, to.name).toString();
}

/**
 * The address lives in the key and the entry; both move. What read it through a dependency reads its new block through one that covers it
 * the same way, and the old one while that holds other objects.
 */
export function moveResource(state: State, from: Address, to: Address): void {
  // Moving a missing entry would create an empty one.
  if (!Object.hasOwn(state.resources, from.toString())) throw new Error(`Cannot move ${from.toString()}: state has no resource there`);

  state.resources[to.toString()] = { ...state.resources[from.toString()], ...to.fields() };
  delete state.resources[from.toString()];
  moveDeposed(state, from.toString(), to.toString());
  // Once for each dependency, since every reader of a block names it the same way.
  const moved = new Map<string, string | undefined>();
  const movedOf = (dependency: string) => {
    if (!moved.has(dependency)) {
      const parsed = Address.parse(dependency);
      moved.set(dependency, covers(parsed, from) ? movedTo(parsed, to) : undefined);
    }
    return moved.get(dependency);
  };
  mapDependencies(state, (dependencies) => {
    const added = dependencies.map((dependency) => movedOf(dependency)).filter((dependency) => dependency !== undefined);
    return added.length > 0 ? [...new Set([...dependencies, ...added])] : dependencies;
  });
  forgetDependencies(state, from);
}
