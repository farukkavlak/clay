import { Address, ModuleAddress, ModuleStep, State } from '@clay/contracts';

/** Changes the dependencies of every resource and deposed object. */
function mapDependencies(state: State, change: (dependencies: string[]) => string[]): void {
  for (const resource of Object.values(state.resources)) if (resource.dependencies) resource.dependencies = change(resource.dependencies);
  const { deposed = {} } = state;
  // New objects, since a copy of the map shares the ones in it.
  for (const [address, objects] of Object.entries(deposed))
    deposed[address] = objects.map((object) => (object.dependencies ? { ...object, dependencies: change(object.dependencies) } : object));
}

/** Every dependency of the state, read without copying a list. */
function dependenciesIn(state: State): Set<string> {
  const objects = [...Object.values(state.resources), ...Object.values(state.deposed ?? {}).flat()];

  return new Set(objects.flatMap((object) => object.dependencies ?? []));
}

/**
 * Each dependency that covers `object`: every module step with a key named with it or without, the resource with none. Spelled out, so
 * a dependency is looked up, not held against every object; two for each keyed module step, and modules are seldom nested deep.
 */
function coveringSpellings(object: Address): string[] {
  let paths: ModuleStep[][] = [[]];
  for (const step of object.module.path)
    paths = paths.flatMap((path) =>
      step.key === undefined
        ? [[...path, step]]
        : [
            [...path, step],
            [...path, { name: step.name }],
          ]
    );

  return paths.map((path) => new Address(new ModuleAddress(path), object.resourceType, object.name).toString());
}

const spellingsOf = (objects: Address[]) => new Set(objects.flatMap((object) => coveringSpellings(object)));

/** Every object state holds, current or deposed. */
function objectsIn(state: State): Address[] {
  return [...Object.values(state.resources).map((resource) => Address.of(resource)), ...Object.keys(state.deposed ?? {}).map((address) => Address.parse(address))];
}

/** A dependency that covered a `removed` object and covers nothing left is dropped; one that covers another object still orders its delete. */
export function forgetDependencies(state: State, removed: Address[]): void {
  const covered = spellingsOf(removed);
  const left = spellingsOf(objectsIn(state));

  mapDependencies(state, (dependencies) => dependencies.filter((dependency) => !covered.has(dependency) || left.has(dependency)));
}

/** `to`'s block, keyed only at the module steps where `dependency` names one instance, so it covers what `dependency` covered there. */
function movedTo(dependency: Address, to: Address): string {
  const path = to.module.path.map((step, index) => (dependency.module.path[index]?.key === undefined ? { name: step.name } : step));

  return new Address(new ModuleAddress(path), to.resourceType, to.name).toString();
}

/** For each dependency that covers a moved object, the blocks that cover where it went the same way. */
function movedDependencies(state: State, moves: [Address, Address][]): Map<string, Set<string>> {
  const present = dependenciesIn(state);

  const moved = new Map<string, Set<string>>();
  for (const [from, to] of moves)
    for (const spelling of coveringSpellings(from)) if (present.has(spelling)) moved.set(spelling, (moved.get(spelling) ?? new Set()).add(movedTo(Address.parse(spelling), to)));

  return moved;
}

interface Taken {
  to: string;
  resource: State['resources'][string];
  deposed?: NonNullable<State['deposed']>[string];
}

/** Each entry is taken out before any is put back, so one move's destination never overwrites another's source. */
function takeEntries(state: State, moves: [Address, Address][]): Taken[] {
  return moves.map(([from, to]) => {
    const resource = { ...state.resources[from.toString()], ...to.fields() };
    const deposed = state.deposed && Object.hasOwn(state.deposed, from.toString()) ? state.deposed[from.toString()] : undefined;
    delete state.resources[from.toString()];
    if (deposed) delete state.deposed![from.toString()];
    return { to: to.toString(), resource, deposed };
  });
}

function placeEntries(state: State, taken: Taken[]): void {
  for (const { to, resource, deposed } of taken) {
    state.resources[to] = resource;
    // What a replace left behind goes with the resource it was left by, after any the new address holds.
    if (deposed) state.deposed![to] = [...(state.deposed![to] ?? []), ...deposed];
  }
}

/**
 * Every move at once. What read a moved object through a dependency reads where it went through one that covers it the same way, and the
 * old one while that holds an object no move touched: an object moved in from elsewhere is not the one it read.
 */
export function moveResources(state: State, moves: [Address, Address][]): void {
  // Moving a missing entry would create an empty one.
  for (const [from] of moves) if (!Object.hasOwn(state.resources, from.toString())) throw new Error(`Cannot move ${from.toString()}: state has no resource there`);

  const taken = takeEntries(state, moves);
  const untouched = spellingsOf(objectsIn(state));
  placeEntries(state, taken);

  const moved = movedDependencies(state, moves);
  const covered = spellingsOf(moves.map(([from]) => from));
  mapDependencies(state, (dependencies) => {
    const kept = dependencies.filter((dependency) => !covered.has(dependency) || untouched.has(dependency));
    const added = dependencies.flatMap((dependency) => [...(moved.get(dependency) ?? [])]);
    return added.length > 0 || kept.length < dependencies.length ? [...new Set([...kept, ...added])] : dependencies;
  });
}

export function moveResource(state: State, from: Address, to: Address): void {
  moveResources(state, [[from, to]]);
}
