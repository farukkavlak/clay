import { Address, InstanceKey, ModuleAddress, Resource, State } from '@clay/contracts';
import { Graph } from '@clay/graph';
import { MovedBlock, spell } from '@clay/parser';
import { PlanAction } from '@clay/planner';
import { moveResource } from '@clay/state';

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
    moveResource(state, from, to);
    // A chain of moves is one move from where the state held it.
    const origin = this.origins.get(from.toString()) ?? from.toString();
    this.origins.delete(from.toString());
    this.origins.set(to.toString(), origin);
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

/** With no key on either side, every instance moves. */
const isWhole = ({ block }: Move) => block.from.key === undefined && block.to.key === undefined;

/** A module step of the declaring module stands for each of its instances, since the move holds in all of them. */
interface Step {
  name: string;
  key?: InstanceKey;
  any: boolean;
}

interface End {
  steps: Step[];
  address: Address;
  whole: boolean;
}

function endOf(move: Move, address: Address): End {
  const declaring = move.module.path.map(({ name }) => ({ name, any: true }));
  const written = address.module.path.map((step) => ({ ...step, any: false }));

  return { steps: [...declaring, ...written], address, whole: isWhole(move) };
}

const ends = (move: Move) => ({ from: endOf(move, move.block.from), to: endOf(move, move.block.to) });

const stepsMatch = (one: End, other: End) =>
  one.steps.length === other.steps.length &&
  one.steps.every((step, index) => {
    const theirs = other.steps[index];
    return step.name === theirs.name && (step.any || theirs.any || step.key === theirs.key);
  });

const sameResource = (one: End, other: End) => stepsMatch(one, other) && one.address.resourceType === other.address.resourceType && one.address.name === other.address.name;

const same = (one: End, other: End) => sameResource(one, other) && one.whole === other.whole && one.address.key === other.address.key;

const within = (inner: End, outer: End) => !inner.whole && outer.whole && sameResource(inner, outer);

/** The end in full, its declaring module's keys taken from `keys` where it has none of its own. */
function spelled({ steps, address }: End, keys: Step[]): Address {
  const path = steps.map(({ name, key, any }, index) => {
    const known = any ? keys[index]?.key : key;
    return known === undefined ? { name } : { name, key: known };
  });

  return new Address(new ModuleAddress(path), address.resourceType, address.name, address.key);
}

const merged = (one: End, other: End): Step[] => one.steps.map((step, index) => (step.any ? other.steps[index] : step));

/** `first` moves what `then` moves on, or an instance moves out of a resource before the rest of it moves on, as Terraform orders them. */
function runsBefore(first: Move, then: Move): boolean {
  const [a, b] = [ends(then), ends(first)];

  return same(a.from, b.to) || within(a.from, b.to) || within(a.to, b.to) || within(b.from, a.from) || within(b.to, a.from);
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

/** Where the move takes `address`, if its `from` names it; a whole resource takes each instance to the same key. */
function destinationOf(address: Address, move: Move): Address | undefined {
  const { from, to } = move.block;
  const depth = move.module.path.length;
  const head = address.module.path.slice(0, depth);
  if (head.length < depth || head.some((step, index) => step.name !== move.module.path[index].name)) return undefined;
  if (new ModuleAddress(address.module.path.slice(depth)).toString() !== from.module.toString()) return undefined;
  if (address.resourceType !== from.resourceType || address.name !== from.name) return undefined;

  const whole = isWhole(move);
  if (!whole && address.key !== from.key) return undefined;

  return new Address(new ModuleAddress([...head, ...to.module.path]), to.resourceType, to.name, whole ? address.key : to.key);
}

/** A whole resource moves only where no instance of the resource is held, and an instance where none is. */
function heldAt(move: Move, to: Address, state: State): string | undefined {
  if (!isWhole(move)) return Object.hasOwn(state.resources, to.toString()) ? to.toString() : undefined;

  const resource = to.withoutKey().toString();
  return Object.keys(state.resources).find((key) => Address.parse(key).withoutKey().toString() === resource);
}

/** What the move takes, all checked before any moves, so a refusal leaves the state as it was. */
function movedBy(move: Move, state: State): [Address, Address][] {
  const found = Object.keys(state.resources).flatMap((key): [Address, Address][] => {
    const from = Address.parse(key);
    const to = destinationOf(from, move);
    return to ? [[from, to]] : [];
  });

  for (const [from, to] of found) {
    const held = heldAt(move, to, state);
    if (held !== undefined) throw refuse(move, `${from} cannot move to ${to}: the state already holds ${held}. Remove the one to forget from the state first, with clay state rm`);
  }

  return found;
}

/** Each state entry a `moved` block names goes to its new address, before anything reads the state. */
export function applyMoves(moves: Move[], state: State, record: Moves): void {
  for (const move of ordered(moves)) for (const [from, to] of movedBy(move, state)) record.move(state, from, to);
}

/** A `from` the configuration still declares would take the state away from its own block. */
export function checkMovedAway(moves: Move[], desired: { address: Address }[]): void {
  for (const move of moves) {
    const declared = desired.find(({ address }) => destinationOf(address, move) !== undefined);
    if (declared) throw refuse(move, `${declared.address} is moved to ${destinationOf(declared.address, move)}, but it is still declared: declare it as ${move.block.to} instead`);
  }
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
