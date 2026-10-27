import { Address, InstanceKey, ModuleAddress, ModuleStep, Resource, spellKey, State } from '@clay/contracts';
import { Graph } from '@clay/graph';
import { MovedBlock, spell } from '@clay/parser';
import { PlanAction } from '@clay/planner';
import { moveResources } from '@clay/state';

import { LoadedModule } from '../config/ModuleLoader';
import { withPlace } from '../place';

/** A `moved` block and the module that declares it, in each of whose instances it moves. */
export interface Move {
  block: MovedBlock;
  module: ModuleAddress;
}

/** Each address a state entry was moved to, and the one the state held it at before the run. */
export class Moves {
  private readonly origins = new Map<string, string>();

  move(state: State, from: Address, to: Address): void {
    this.moveAll(state, [[from, to]]);
  }

  /** Together, so what reads them is rewritten once. */
  moveAll(state: State, moves: [Address, Address][]): void {
    moveResources(state, moves);
    // A chain of moves is one move from where the state held it.
    const origins = moves.map(([from, to]) => [to.toString(), this.origins.get(from.toString()) ?? from.toString()] as const);
    for (const [from] of moves) this.origins.delete(from.toString());
    for (const [to, origin] of origins) this.origins.set(to, origin);
  }

  originOf(address: string): string | undefined {
    return this.origins.get(address);
  }
}

/** Plan and apply move entries and rewrite dependencies, so each works on its own copy. */
export function copyResources(resources: Record<string, Resource>): Record<string, Resource> {
  return Object.fromEntries(Object.entries(resources).map(([key, resource]) => [key, { ...resource }]));
}

/** A move changes the maps, never a list in them, so a copy of each map is its own. */
export function copyForMoves(state: State): State {
  return { ...state, resources: copyResources(state.resources), ...(state.deposed && { deposed: { ...state.deposed } }) };
}

export function movesIn(modules: LoadedModule[]): Move[] {
  return modules.flatMap(({ address, program }) => program.flatMap((statement) => (statement.type === 'Moved' ? [{ block: statement, module: address }] : [])));
}

const refuse = ({ block, module }: Move, message: string) => withPlace(new Error(message), block.position, spell(block), module);

type ModuleMove = Extract<MovedBlock, { kind: 'module' }>;

const keyOf = (endpoint: Address | ModuleAddress) => (endpoint instanceof Address ? endpoint.key : endpoint.path.at(-1)?.key);

/** With no key on either side, every instance moves. */
const isWhole = ({ block }: Move) => keyOf(block.from) === undefined && keyOf(block.to) === undefined;

/** Only a module's keys change. */
const isReIndex = ({ block }: Move) => block.kind === 'module' && block.from.withoutKeys().toString() === block.to.withoutKeys().toString();

/** A module step of the declaring module stands for each of its instances, since the move holds in all of them, and so does what a whole move moves. */
interface Step {
  name: string;
  key?: InstanceKey;
  any: boolean;
}

/** The steps to what moves, the last one the resource or the module. */
interface End {
  steps: Step[];
  resource: boolean;
  whole: boolean;
}

function endOf(move: Move, endpoint: Address | ModuleAddress): End {
  const whole = isWhole(move);
  const declaring = move.module.path.map(({ name }) => ({ name, any: true }));
  const resource = endpoint instanceof Address;
  const written = (resource ? endpoint.module.path : endpoint.path).map((step) => ({ ...step, any: false }));
  // Named with its type, a resource step never matches a module step.
  const steps = resource ? [...declaring, ...written, { name: `${endpoint.resourceType}.${endpoint.name}`, key: endpoint.key, any: false }] : [...declaring, ...written];
  const last = steps.length - 1;

  return { steps: steps.map((step, index) => (index === last ? { ...step, any: whole } : step)), resource, whole };
}

const ends = (move: Move) => ({ from: endOf(move, move.block.from), to: endOf(move, move.block.to) });

const stepMatches = (one: Step, other: Step) => one.name === other.name && (one.any || other.any || one.key === other.key);

const startsWith = (steps: Step[], prefix: Step[]) => prefix.length <= steps.length && prefix.every((step, index) => stepMatches(step, steps[index]));

const same = (one: End, other: End) => one.whole === other.whole && one.steps.length === other.steps.length && startsWith(one.steps, other.steps);

/** In a module `outer` moves, or an instance of what `outer` moves whole. */
function within(inner: End, outer: End): boolean {
  if (inner.steps.length > outer.steps.length) return startsWith(inner.steps, outer.steps);

  return inner.steps.length === outer.steps.length && outer.whole && !inner.whole && startsWith(inner.steps, outer.steps);
}

/** The end in full, its declaring module's keys taken from `keys` where it has none of its own. */
function spelled({ steps, resource }: End, keys: Step[]): string {
  const last = steps.length - 1;

  return steps.map(({ name, key, any }, index) => `${resource && index === last ? '' : 'module.'}${name}${spellKey(any ? keys[index]?.key : key)}`).join('.');
}

const merged = (one: End, other: End): Step[] => one.steps.map((step, index) => (step.any ? other.steps[index] : step));

/** `first` moves what `then` moves on, or one moves what is in what the other moves, as Terraform orders them. */
function runsBefore(first: Move, then: Move): boolean {
  const [a, b] = [ends(then), ends(first)];
  if (same(a.from, b.to)) return true;
  if (!(within(a.from, b.to) || within(a.to, b.to) || within(b.from, a.from) || within(b.to, a.from))) return false;

  // Else a move that changes only a module's keys and a move inside that module would each wait for the other.
  return then.module.path.length >= first.module.path.length || !isReIndex(then);
}

/** Each address moves to one place, and each place is moved to from one address. */
function checkAmbiguous(moves: Move[]): void {
  for (const [index, move] of moves.entries())
    for (const other of moves.slice(0, index)) {
      const [mine, theirs] = [ends(move), ends(other)];
      if (same(mine.from, theirs.from) && !same(mine.to, theirs.to)) {
        const keys = merged(mine.from, theirs.from);
        throw refuse(move, `${spelled(mine.from, keys)} is moved to both ${spelled(theirs.to, keys)} and ${spelled(mine.to, keys)}: an address moves to one place`);
      }
      if (same(mine.to, theirs.to) && !same(mine.from, theirs.from)) {
        const keys = merged(mine.to, theirs.to);
        throw refuse(move, `${spelled(mine.to, keys)} is moved to from both ${spelled(theirs.from, keys)} and ${spelled(mine.from, keys)}: one address moves to each place`);
      }
    }
}

/** Every move after the ones it builds on; moves in a circle leave nothing a last address. */
function ordered(moves: Move[]): Move[] {
  checkAmbiguous(moves);
  const graph = new Graph<Move>();
  for (const [index, move] of moves.entries()) graph.addNode(String(index), move);
  for (const [index, move] of moves.entries())
    for (const [other, then] of moves.entries()) if (index !== other && runsBefore(move, then)) graph.addEdge(String(index), String(other));

  const cycle = graph.findCycle();
  if (cycle) {
    const circle = cycle.slice(0, -1).map((id) => moves[Number(id)].block);
    throw refuse(moves[Number(cycle[0])], `moved blocks move in a circle, so nothing has a last address: ${circle.map(({ from, to }) => `${from} to ${to}`).join(', ')}`);
  }

  return graph.topologicalSort().flatMap((layer) => layer.map((id) => moves[Number(id)]));
}

/** The steps of `path` in the declaring module, if `path` is in one of its instances. */
function declaringIn(path: readonly ModuleStep[], move: Move): readonly ModuleStep[] | undefined {
  const depth = move.module.path.length;
  const head = path.slice(0, depth);

  return head.length === depth && head.every((step, index) => step.name === move.module.path[index].name) ? head : undefined;
}

/** Whether `path` starts with `prefix`, the last step of a whole move in any instance. */
function under(path: readonly ModuleStep[], prefix: readonly ModuleStep[], whole: boolean): boolean {
  const last = prefix.length - 1;

  return prefix.every((step, index) => path[index]?.name === step.name && ((whole && index === last) || path[index].key === step.key));
}

/** Where the move takes a module instance in its `from`, keeping what is under it; a call takes each instance to the same key. */
function movedModule(module: ModuleAddress, move: Move, { from, to }: ModuleMove): ModuleAddress | undefined {
  const head = declaringIn(module.path, move);
  const whole = isWhole(move);
  if (!head || !under(module.path.slice(head.length), from.path, whole)) return undefined;

  const [moved, ...below] = module.path.slice(head.length + from.path.length - 1);
  const [{ name }] = to.path.slice(-1);
  const target = whole ? [...to.path.slice(0, -1), moved.key === undefined ? { name } : { name, key: moved.key }] : to.path;

  return new ModuleAddress([...head, ...target, ...below]);
}

/** Where the move takes a resource instance, if its `from` names it; a whole resource takes each instance to the same key. */
function movedResource(address: Address, move: Move, { from, to }: Extract<MovedBlock, { kind: 'resource' }>): Address | undefined {
  const head = declaringIn(address.module.path, move);
  if (!head || new ModuleAddress(address.module.path.slice(head.length)).toString() !== from.module.toString()) return undefined;
  if (address.resourceType !== from.resourceType || address.name !== from.name) return undefined;

  const whole = isWhole(move);
  if (!whole && address.key !== from.key) return undefined;

  return new Address(new ModuleAddress([...head, ...to.module.path]), to.resourceType, to.name, whole ? address.key : to.key);
}

function destinationOf(address: Address, move: Move): Address | undefined {
  const { block } = move;
  if (block.kind === 'resource') return movedResource(address, move, block);

  const module = movedModule(address.module, move, block);
  return module && new Address(module, address.resourceType, address.name, address.key);
}

/** Where a key is held, by what a move's destination is compared on: the module up to its depth, the resource, or the instance. */
function placeOf(move: Move, address: Address): string | undefined {
  const { block } = move;
  if (block.kind === 'resource') return (isWhole(move) ? address.withoutKey() : address).toString();

  const depth = move.module.path.length + block.to.path.length;
  if (address.module.path.length < depth) return undefined;
  const target = address.module.path.slice(0, depth);
  // A whole call is held by any instance of it.
  return new ModuleAddress(isWhole(move) ? [...target.slice(0, -1), { name: target[depth - 1].name }] : target).toString();
}

/**
 * A whole resource moves only where no instance of the resource is held, and an instance where none is.
 * A module moves only where nothing is held in it, and a whole call where nothing is held in any of its instances.
 * Indexed once for the move, so each destination is looked up, not searched for.
 */
function heldBy(move: Move, others: string[]): (to: Address) => string | undefined {
  const held = new Map<string, string>();
  for (const key of others) {
    const place = placeOf(move, Address.parse(key));
    if (place !== undefined && !held.has(place)) held.set(place, key);
  }

  return (to) => {
    const place = placeOf(move, to);
    return place === undefined ? undefined : held.get(place);
  };
}

/** What the move takes, all checked before any moves, so a refusal leaves the state as it was. */
function movedBy(move: Move, state: State): [Address, Address][] {
  const found = Object.keys(state.resources).flatMap((key): [Address, Address][] => {
    const from = Address.parse(key);
    const to = destinationOf(from, move);
    return to ? [[from, to]] : [];
  });

  const moving = new Set(found.map(([from]) => from.toString()));
  const heldAt = heldBy(
    move,
    Object.keys(state.resources).filter((key) => !moving.has(key))
  );
  for (const [from, to] of found) {
    const held = heldAt(to);
    if (held !== undefined) throw refuse(move, `${from} cannot move to ${to}: the state already holds ${held}. Remove the one to forget from the state first, with clay state rm`);
  }

  return found;
}

/** Each state entry a `moved` block names goes to its new address, before anything reads the state. */
export function applyMoves(moves: Move[], state: State, record: Moves): void {
  for (const move of ordered(moves)) record.moveAll(state, movedBy(move, state));
}

/** What the configuration declares that the move's `from` names, and where the move takes it. */
function stillDeclared(move: Move, desired: { address: Address }[], modules: ModuleAddress[]): [string, string] | undefined {
  const { block } = move;
  if (block.kind === 'resource') {
    const found = desired.find(({ address }) => destinationOf(address, move) !== undefined);
    return found && [found.address.toString(), String(destinationOf(found.address, move))];
  }

  const found = modules.find((module) => movedModule(module, move, block) !== undefined);
  return found && [found.toString(), String(movedModule(found, move, block))];
}

/** A `from` the configuration still declares would take the state away from its own block. */
export function checkMovedAway(moves: Move[], desired: { address: Address }[], modules: ModuleAddress[]): void {
  for (const move of moves) {
    const [declared, destination] = stillDeclared(move, desired, modules) ?? [];
    if (declared) throw refuse(move, `${declared} is moved to ${destination}, but it is still declared: declare it as ${move.block.to} instead`);
  }
}

/** Every move the plan made, from where the state held each entry before the run. */
export function plannedMoves(actions: PlanAction[]): [Address, Address][] {
  return actions.flatMap((action): [Address, Address][] => (action.movedFrom ? [[Address.parse(action.movedFrom), Address.of(action)]] : []));
}

/** A saved plan moves only what the configuration's moves would, or what a count that came or went would. */
export function checkMovedFrom(actions: PlanAction[], moves: Move[], prior: State): void {
  const record = new Moves();
  applyMoves(moves, copyForMoves(prior), record);

  for (const { movedFrom, ...action } of actions) {
    if (movedFrom === undefined) continue;

    const address = Address.of(action);
    const allowed = [address, ...address.countCounterparts()].map((kept) => record.originOf(kept.toString()) ?? kept.toString());
    if (!allowed.includes(movedFrom)) throw new Error(`The saved plan moves ${address} from ${movedFrom}, which the configuration does not. Plan again.`);
  }
}
